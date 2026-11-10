import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * C1 — ESTADO FIRMADO del OAuth de Meta, con a dónde volver.
 *
 * El `state` del OAuth viajaba con el id de la organización y nada más, y el callback
 * redirigía SIEMPRE al panel de TuBot. Para que un cliente de Conversia conecte Instagram
 * desde su pantalla de Canales hay que recordar tres cosas durante el viaje a Meta: de quién
 * es, para qué era (mensajería o leads) y a qué pantalla vuelve.
 *
 * Lo delicado es el "a dónde vuelve": es un dato que viene de la URL y termina en un
 * `Location:`. Si se aceptara cualquier cosa, sería un redirect abierto —el clásico truco de
 * mandar a alguien a `?return=https://sitio-falso.cl` y que el dominio de confianza lo
 * reenvíe—. Por eso:
 *   · solo RUTAS relativas que empiezan con una sola barra,
 *   · nada de `//` (eso es "otro host" para el navegador), ni `:`, ni `\`, ni `..`,
 *   · y, por si acaso, va FIRMADO: ni siquiera una ruta válida se puede cambiar a mitad del
 *     viaje sin romper la firma.
 */

/** Minutos que vale un `state` (el viaje a Meta y la vuelta). */
const VIGENCIA_SEGUNDOS = 600;

export type PropositoOAuth = "leads" | "messaging";

export interface EstadoOAuth {
  orgId: string;
  purpose: PropositoOAuth;
  /** Ruta relativa del panel a la que volver (por ejemplo `/canales`). */
  retorno: string;
}

/**
 * Ruta de retorno aceptable. Empieza con una barra, sigue con caracteres de ruta y punto
 * final: sin esquema, sin host, sin `..` y sin `\` (que algunos navegadores normalizan a `/`).
 */
export const rutaDeRetornoSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\/[A-Za-z0-9\-_/]*$/, "ruta relativa inválida")
  .refine((r) => !r.startsWith("//"), "no puede apuntar a otro host")
  .refine((r) => !r.includes(".."), "no puede subir de directorio");

/** `null` si la ruta no es aceptable (el llamador decide el default). */
export function rutaDeRetornoValida(valor: unknown): string | null {
  const r = rutaDeRetornoSchema.safeParse(valor);
  return r.success ? r.data : null;
}

const firma = (cuerpo: string, secreto: string): string => createHmac("sha256", secreto).update(cuerpo).digest("hex");

export function firmarEstado(e: EstadoOAuth, secreto: string, ts = Math.floor(Date.now() / 1000)): string {
  const cuerpo = JSON.stringify({ o: e.orgId, p: e.purpose, r: e.retorno, t: ts });
  const b64 = Buffer.from(cuerpo).toString("base64url");
  return `${b64}.${firma(b64, secreto)}`;
}

/**
 * Verifica y abre el `state`. Acepta TAMBIÉN el formato viejo (`orgId.ts.sig`) para que un
 * viaje a Meta que empezó antes de este cambio no quede colgado a mitad de camino.
 */
export function verificarEstado(state: string, secreto: string, ahoraMs = Date.now()): EstadoOAuth | null {
  if (!state) return null;
  const partes = state.split(".");
  // Formato nuevo: <base64url>.<firma>
  if (partes.length === 2) {
    const [b64, sig] = partes;
    const esperada = firma(b64, secreto);
    if (esperada.length !== sig.length) return null;
    if (!timingSafeEqual(Buffer.from(esperada), Buffer.from(sig))) return null;
    try {
      const d = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { o?: string; p?: string; r?: string; t?: number };
      if (!d.o || !d.t) return null;
      if (Math.abs(ahoraMs / 1000 - d.t) > VIGENCIA_SEGUNDOS) return null;
      const retorno = rutaDeRetornoValida(d.r);
      // La ruta se vuelve a validar al ABRIR el estado, no solo al firmarlo: si alguna vez
      // se firmara algo que no debía, acá se corta igual.
      return { orgId: d.o, purpose: d.p === "messaging" ? "messaging" : "leads", retorno: retorno ?? "" };
    } catch {
      return null;
    }
  }
  // Formato viejo: <orgId>.<ts>.<sig> (sin propósito ni retorno).
  if (partes.length === 3) {
    const [orgId, ts, sig] = partes;
    if (!orgId || !ts || !sig) return null;
    if (Math.abs(ahoraMs / 1000 - Number(ts)) > VIGENCIA_SEGUNDOS) return null;
    const esperada = firma(`${orgId}.${ts}`, secreto);
    if (esperada.length !== sig.length) return null;
    if (!timingSafeEqual(Buffer.from(esperada), Buffer.from(sig))) return null;
    return { orgId, purpose: "leads", retorno: "" };
  }
  return null;
}

/**
 * A dónde mandar al cliente de vuelta. `base` es el sitio de SU marca (`brandOf(org).webUrl`):
 * antes esto era siempre `WEB_URL`, o sea el panel de TuBot, incluso para una org de Conversia.
 */
export function urlDeVuelta(base: string, retorno: string, resultado: "ok" | "permisos" | "error" | "invalid" | "denied"): string {
  const sitio = base.replace(/\/+$/, "");
  const ruta = rutaDeRetornoValida(retorno) ?? "/integrations/meta-crm";
  return `${sitio}${ruta}?meta=${resultado}`;
}
