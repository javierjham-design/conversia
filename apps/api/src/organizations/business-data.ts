import { z } from "zod";
import type { PrismaService } from "../prisma.service";
import { INDUSTRIES } from "../common/industries";

/**
 * COP 1 — DATOS DEL NEGOCIO: un solo escritor.
 *
 * El paso bloqueante nº1 del montaje ("Completa los datos de tu negocio") exige nombre,
 * rubro, dirección y horario. Hasta ahora había dos problemas:
 *
 *  1. `/ajustes` no tenía formulario para nada de eso (pendiente anotado en la fila 3 del
 *     plan), así que el paso solo se completaba si el instalador de rubros lo rellenaba.
 *  2. Cada dato se guardaba donde le tocaba: el nombre en `organization.name`, el rubro en
 *     `settings.general.industry`, la dirección en `settings.business.direccion`. Con dos
 *     escritores (el copiloto y el panel) eso se desincroniza solo.
 *
 * Esta función es el ÚNICO lugar que escribe esos campos. La usan la herramienta
 * `completarDatosNegocio` del copiloto y `PUT /settings/business` del panel, así que lo que
 * el dueño guarda a mano y lo que guarda conversando terminan en el mismo sitio —y el
 * checklist los ve igual en los dos casos.
 */

export const businessDataSchema = z.object({
  nombre: z.string().trim().min(2).max(80).optional(),
  rubro: z.string().trim().max(60).optional(),
  direccion: z.string().trim().max(200).optional(),
  descripcion: z.string().trim().max(500).optional(),
});

export type BusinessDataInput = z.infer<typeof businessDataSchema>;

/**
 * Horario de atención del negocio, el cuarto dato que exige el paso nº1 del montaje.
 *
 * BUG ARREGLADO (28-oct): las tres expresiones de `PUT /settings/hours` decían `d{2}` en vez
 * de `\d{2}` —"la letra d dos veces"—, así que "09:00" NO pasaba y el endpoint respondía
 * "Horario inválido" para CUALQUIER horario real, mientras "dd:dd" sí pasaba. Con eso el
 * paso bloqueante era imposible de completar desde el panel. Vive acá, exportado, para que
 * `settings-hours.spec.ts` pueda probar las dos direcciones sin levantar la API.
 *
 * `holidays` es opcional y SIN default: el guardado hace merge de la sección, así que un
 * `holidays: []` por omisión borraría los feriados ya cargados.
 */
const HHMM = /^\d{2}:\d{2}$/;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export const businessHoursSchema = z.object({
  hours: z.record(
    z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    z.array(z.object({ from: z.string().regex(HHMM), to: z.string().regex(HHMM) })).max(4),
  ),
  holidays: z.array(z.string().regex(FECHA_ISO)).max(60).optional(),
});

export interface BusinessDataResult {
  ok: boolean;
  /** Campos que se guardaron, en español, para confirmárselo al dueño. */
  guardado: string[];
  /** Mensaje de error (rubro fuera del catálogo, nada que guardar). */
  error?: string;
}

/** ¿Es un código de rubro del catálogo? El rubro manda vocabulario y módulos, no es texto libre. */
export function esRubroValido(code: string): boolean {
  return INDUSTRIES.some((i) => i.code === code);
}

export const RUBROS_VALIDOS = INDUSTRIES.map((i) => i.code);

/**
 * Guarda los datos del negocio. Solo toca los campos que vienen: mandar únicamente la
 * dirección no borra el rubro. El `organizationId` lo pone siempre el caller desde el JWT.
 */
export async function guardarDatosNegocio(
  prisma: PrismaService,
  actor: { organizationId: string; userId: string | null },
  input: BusinessDataInput,
): Promise<BusinessDataResult> {
  const nombre = input.nombre?.trim() ?? "";
  const rubro = input.rubro?.trim().toLowerCase() ?? "";
  const direccion = input.direccion?.trim() ?? "";
  const descripcion = input.descripcion?.trim() ?? "";
  if (!nombre && !rubro && !direccion && !descripcion) {
    return { ok: false, guardado: [], error: "No hay ningún dato para guardar." };
  }
  if (rubro && !esRubroValido(rubro)) {
    return { ok: false, guardado: [], error: `El rubro "${rubro}" no está en el catálogo.` };
  }

  const org = await prisma.admin.organization.findUnique({
    where: { id: actor.organizationId },
    select: { settings: true },
  });
  const settings = ((org?.settings ?? {}) as Record<string, any>) ?? {};
  const general = { ...((settings.general ?? {}) as Record<string, any>) };
  const business = { ...((settings.business ?? {}) as Record<string, any>) };
  if (rubro) general.industry = rubro;
  if (direccion) business.direccion = direccion;
  if (descripcion) business.descripcion = descripcion;
  // `business.nombre` lo escribe también el borrador de /crear (apply-draft): lo mantenemos
  // alineado con `organization.name` para que no queden dos nombres distintos del negocio.
  if (nombre) business.nombre = nombre;

  await prisma.admin.organization.update({
    where: { id: actor.organizationId },
    data: {
      ...(nombre ? { name: nombre } : {}),
      settings: { ...settings, general, business } as object,
    },
  });
  await prisma.admin.auditLog
    .create({
      data: {
        organizationId: actor.organizationId,
        actorType: "user",
        actorId: actor.userId ?? "assistant",
        action: "settings.business_update",
        entityType: "organization",
        entityId: actor.organizationId,
        after: { nombre, rubro, direccion, descripcion } as object,
      },
    })
    .catch(() => undefined);

  const guardado = [
    nombre && "el nombre",
    rubro && "el rubro",
    direccion && "la dirección",
    descripcion && "la descripción",
  ].filter(Boolean) as string[];
  return { ok: true, guardado };
}

/** Lee los datos del negocio tal como los muestra el formulario de `/ajustes`. */
export async function leerDatosNegocio(prisma: PrismaService, organizationId: string) {
  const org = await prisma.admin.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, settings: true },
  });
  const settings = ((org?.settings ?? {}) as Record<string, any>) ?? {};
  const general = (settings.general ?? {}) as Record<string, any>;
  const business = (settings.business ?? {}) as Record<string, any>;
  const miniSite = (settings.miniSite ?? {}) as Record<string, any>;
  return {
    nombre: org?.name ?? "",
    rubro: typeof general.industry === "string" ? general.industry : "",
    // La dirección pudo quedar en el mini-sitio si el dueño lo llenó primero: la mostramos
    // en vez de pedírsela de nuevo.
    direccion: String(business.direccion ?? business.address ?? miniSite.address ?? general.address ?? ""),
    descripcion: String(business.descripcion ?? ""),
    rubros: INDUSTRIES.map((i) => ({ code: i.code, label: i.label })),
  };
}
