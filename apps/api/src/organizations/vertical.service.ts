import { BadRequestException, Injectable } from "@nestjs/common";
import { loadVerticalData } from "@conversia/database";
import { PrismaService } from "../prisma.service";

/** Origen de la instalación → gobierna qué rubros se permiten (catálogo CONVERSIA_RUBROS.md). */
export type InstallSource = "registration" | "tenant" | "platform";

/**
 * Features de producto DISPONIBLES hoy. Una plantilla con `requiresFeature` que incluya
 * algo fuera de este set NO es instalable (p. ej. gimnasio exige "groupClasses" = clases
 * grupales con cupos, que llega post-F4). Al implementarlas, se agregan aquí.
 */
const AVAILABLE_FEATURES = new Set<string>([]);

/**
 * Gate de instalación (PURO, testeable sin BD): decide si una plantilla se puede instalar
 * según el origen y las features disponibles. Registro público = solo ola 1 active; tenant
 * = cualquier active; plataforma (equipo) = también beta; `requiresFeature` bloquea a todos.
 */
export function evaluateInstallGate(
  tpl: { status: string; wave: number; requiresFeature: unknown },
  source: InstallSource,
  available: Set<string> = AVAILABLE_FEATURES,
): { ok: true } | { ok: false; reason: string } {
  if (source === "registration" && (tpl.status !== "active" || tpl.wave !== 1)) {
    return { ok: false, reason: "no disponible para registro" };
  }
  if (source === "tenant" && tpl.status !== "active") {
    return { ok: false, reason: "aún no disponible" };
  }
  const required = Array.isArray(tpl.requiresFeature) ? (tpl.requiresFeature as string[]) : [];
  const missing = required.filter((f) => !available.has(f));
  if (missing.length) return { ok: false, reason: `requiere funciones aún no disponibles: ${missing.join(", ")}` };
  return { ok: true };
}

/**
 * Instalador de PAQUETES VERTICALES (F2). Lee la plantilla global del catálogo con el
 * cliente admin (RLS oculta las filas org_id NULL al rol de app) e instala sus DATOS
 * en el tenant dentro de UNA transacción con RLS (withTenant). Idempotente (los loaders
 * hacen upsert) y "aplica el rubro" escribiéndolo en settings (lo consume
 * resolvePersonalization). Los agentes/flujos quedan en BORRADOR (publish:false): el
 * equipo o el montaje asistido los publica tras personalizar.
 *
 * GATES (catálogo de rubros): el registro público solo instala wave 1 + status active;
 * un tenant puede instalar cualquier rubro active; los beta solo los instala el equipo
 * (source "platform", consola F10). `requiresFeature` bloquea a TODOS hasta que la
 * función exista (gimnasio hasta post-F4). Prohibido `if (rubro === ...)`: todo sale de
 * la plantilla (variant incluido).
 */
@Injectable()
export class VerticalService {
  constructor(private prisma: PrismaService) {}

  async install(
    organizationId: string,
    key: string,
    opts: { version?: number; source?: InstallSource } = {},
  ): Promise<{ key: string; version: number; variant: string }> {
    const admin = this.prisma.admin;
    const source: InstallSource = opts.source ?? "platform";
    const tpl = opts.version
      ? await admin.verticalTemplate.findUnique({ where: { key_version: { key, version: opts.version } } })
      : await admin.verticalTemplate.findFirst({ where: { key, active: true }, orderBy: { version: "desc" } });
    if (!tpl || !tpl.active) {
      throw new BadRequestException(`No hay un paquete vertical activo para el rubro "${key}".`);
    }
    // Gate (origen + features): registro=ola1 active; tenant=active; plataforma=también beta;
    // requiresFeature bloquea a todos (gimnasio hasta post-F4). Prohibido if (rubro===...).
    const gate = evaluateInstallGate({ status: tpl.status, wave: tpl.wave, requiresFeature: tpl.requiresFeature }, source);
    if (!gate.ok) {
      throw new BadRequestException(`El rubro "${key}" ${gate.reason}.`);
    }
    const definition = (tpl.definition ?? {}) as Record<string, any>;

    await this.prisma.withTenant(organizationId, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true, currency: true, settings: true },
      });
      // Datos del rubro (borrador). Loaders compartidos con el seed.
      await loadVerticalData(
        tx,
        organizationId,
        { timezone: org?.timezone ?? "America/Santiago", currency: org?.currency ?? "CLP" },
        definition,
        { publish: false },
      );
      // Aplica el rubro en settings (merge, no pisa otras claves): industry (lo lee
      // resolvePersonalization) + horarios + overrides opcionales que traiga el paquete.
      const settings = (org?.settings ?? {}) as Record<string, any>;
      // La VARIANTE sale de la plantilla (citas|leads|mesas|intake|estadias|pedidos). La
      // guardamos en settings para que la UI sepa qué módulos aplican; el instalador NO
      // fuerza agenda (solo aplica definition.modules — una plantilla no-citas trae
      // modules.agenda=false y su embudo/agentes/flujos propios).
      const nextSettings: Record<string, any> = {
        ...settings,
        general: { ...(settings.general ?? {}), industry: definition.industry ?? key, variant: tpl.variant },
        vertical: { key: tpl.key, version: tpl.version, variant: tpl.variant, installedAt: new Date().toISOString() },
      };
      if (definition.businessHours) nextSettings.businessHours = definition.businessHours;
      if (definition.vocabulary) nextSettings.vocabulary = { ...(settings.vocabulary ?? {}), ...definition.vocabulary };
      if (definition.modules) nextSettings.modules = { ...(settings.modules ?? {}), ...definition.modules };
      await tx.organization.update({ where: { id: organizationId }, data: { settings: nextSettings as object } });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorType: "system",
          action: "vertical.install",
          entityType: "vertical_template",
          entityId: tpl.id,
          after: { key: tpl.key, version: tpl.version },
        },
      });
    });

    return { key: tpl.key, version: tpl.version, variant: tpl.variant };
  }
}
