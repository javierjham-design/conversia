import IORedis from "ioredis";
import { getEnv, brandOf } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import { opsAlert } from "./ops-alert.js";

/**
 * Convierte "WhatsApp dejó de ENVIAR mensajes" en una alerta al titular/usuarios.
 *
 * El caso real (Digital-Dent, 1-nov): Meta bloqueó el envío de la cuenta por un
 * problema de pago (#131042 "unsettled payments") y los RECORDATORIOS/confirmaciones
 * (plantillas) rebotaron ~8 h. Nadie se enteró: el fallo de una plantilla llega
 * ASÍNCRONO por webhook `statuses` (Meta acepta el envío con 200 y después avisa que
 * no se entregó), así que no pasa por el catch del envío (markChannelConfigError) y
 * quedaba solo como una fila `message.failed` sin avisar a nadie.
 *
 * Aquí, en ese mismo punto del webhook, detectamos los errores de CUENTA (no de un
 * destinatario) y, UNA vez por incidente (dedupe en Redis, igual que ai-health.ts):
 *   1. Registramos el incidente en integration_events (panel de Alertas).
 *   2. Enviamos correo al/los administrador(es) del tenant (el titular y sus usuarios).
 *   3. Avisamos a ops (OPS_ALERT_WEBHOOK_URL → BetterStack).
 * Cuando un mensaje se vuelve a ENTREGAR, limpiamos la marca y avisamos la recuperación.
 * Todo best-effort: NUNCA rompe el procesamiento del webhook.
 */

/** Caduca sola: si tras 2 h el bloqueo sigue, un nuevo fallo vuelve a alertar. */
const TTL_SECONDS = 2 * 60 * 60;
const blockedKey = (organizationId: string): string => `conversia:whatsapp:sending-blocked:${organizationId}`;

export interface BlockingSendError {
  code: string;
  /** Motivo corto para el texto del aviso. */
  reason: string;
}

/**
 * ¿Es un error que bloquea el envío de TODA la cuenta (y que un humano debe resolver),
 * o ruido por-destinatario? Solo los primeros ameritan despertar al titular:
 *  - 131042: problema de pago / elegibilidad ("unsettled payments", método de pago).
 *  - 131031: cuenta de WhatsApp Business bloqueada o restringida en Meta.
 * NO alertan (reintentar o son del destinatario, no de la cuenta): 131026 (número no
 * recibe), 131047 (ventana de 24 h cerrada), 130429/131056 (rate limit). El token
 * vencido (190/401) ya tiene su propio camino en channel-auth.ts (markChannelAuthError).
 */
export function classifyBlockingSendError(errorText: string | null | undefined): BlockingSendError | null {
  if (!errorText) return null;
  const code = /Meta #(\d+)/.exec(errorText)?.[1] ?? /"code":\s*(\d+)/.exec(errorText)?.[1] ?? null;
  const t = errorText.toLowerCase();
  if (code === "131042" || t.includes("unsettled payment") || t.includes("payment method"))
    return { code: "131042", reason: "problema de pago o elegibilidad en Meta" };
  if (code === "131031" || t.includes("account has been locked") || t.includes("account is restricted"))
    return { code: "131031", reason: "cuenta de WhatsApp Business bloqueada o restringida en Meta" };
  return null;
}

interface BlockedInfo {
  since: number;
  lastSeen: number;
  code: string;
  reason: string;
  sample: string;
}

type RedisLike = Pick<IORedis, "get" | "set" | "del">;
type RecordEvent = (organizationId: string, status: string, type: string, message: string, payload: object) => Promise<void>;
type NotifyOwner = (organizationId: string, subject: string, html: string) => Promise<void>;
type Ops = typeof opsAlert;

export interface SendHealthDeps {
  /** Inyectables para tests; por defecto usan Redis/BD/Resend/ops reales. */
  redis?: RedisLike;
  record?: RecordEvent;
  notifyOwner?: NotifyOwner;
  ops?: Ops;
  /** Por defecto solo en producción (en dev/test no hay envíos reales de Meta). */
  enabled?: boolean;
  now?: () => number;
}

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

/** Correos del titular y sus usuarios (igual criterio que cobranza: miembros activos). */
async function ownerEmails(organizationId: string): Promise<string[]> {
  const admin = getAdminPrisma();
  const members = await admin.organizationUser.findMany({
    where: { organizationId, active: true },
    select: { user: { select: { email: true } } },
    take: 10,
  });
  return [...new Set(members.map((m) => m.user?.email).filter((e): e is string => !!e))];
}

/** Correo al titular/usuarios por el remitente de la MARCA del tenant (key Resend por marca). */
async function notifyOwnerReal(organizationId: string, subject: string, html: string): Promise<void> {
  const to = await ownerEmails(organizationId);
  if (!to.length) return;
  const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
  const brand = brandOf(org);
  if (!brand.resendApiKey) return; // sin remitente de plataforma para la marca: el panel ya dejó traza
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${brand.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: brand.mailFrom, to, subject, html }),
  });
}

async function recordEventReal(organizationId: string, status: string, type: string, message: string, payload: object): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.integrationEvent.create({ data: { organizationId, provider: "whatsapp", type, status, message, payload } }),
  );
}

function blockedEmail(info: BlockedInfo): { subject: string; html: string } {
  const esPago = info.code === "131042";
  const subject = esPago
    ? "🚨 WhatsApp no está enviando mensajes (problema de pago en Meta)"
    : "🚨 WhatsApp no está enviando mensajes (cuenta restringida en Meta)";
  const queHacer = esPago
    ? `<li>Entra a <b>Meta Business Manager → Facturación</b> de tu cuenta de WhatsApp Business y paga el saldo pendiente (o revisa el método de pago — si la tarjeta fue rechazada, agrega una nueva como principal y reintenta).</li>
       <li>Ojo: el pago de WhatsApp es <b>aparte</b> del saldo de Anuncios; pagar Anuncios no lo desbloquea.</li>`
    : `<li>Revisa el estado de tu cuenta de WhatsApp Business en <b>Meta Business Manager</b>: puede tener una restricción o violación de políticas que resolver.</li>`;
  const html =
    `<div style="font-family:system-ui,Arial;max-width:560px;margin:auto;color:#0f172a">` +
    `<h2 style="color:#b91c1c">WhatsApp dejó de enviar mensajes</h2>` +
    `<p>Meta está <b>rechazando los envíos</b> de tu cuenta de WhatsApp por un <b>${info.reason}</b>. ` +
    `Mientras tanto, los <b>recordatorios y confirmaciones de citas no se están entregando</b> (las respuestas dentro de la conversación sí siguen saliendo).</p>` +
    `<p><b>Qué hacer:</b></p><ul>${queHacer}</ul>` +
    `<p>En cuanto se resuelva, los envíos se reactivan solos y te avisaremos. No hay que tocar nada en el bot.</p>` +
    `<p style="font-size:12px;color:#64748b">Detalle de Meta: ${escapeHtml(info.sample)}</p></div>`;
  return { subject, html };
}

/**
 * Registra un fallo de ENVÍO visto en el webhook de estados. Si es un bloqueo de cuenta,
 * alerta UNA vez por incidente. Llamar best-effort (no bloquea el webhook).
 */
export async function observeSendFailure(organizationId: string, errorText: string | null | undefined, deps: SendHealthDeps = {}): Promise<void> {
  const enabled = deps.enabled ?? getEnv().NODE_ENV === "production";
  if (!enabled) return;
  const blocking = classifyBlockingSendError(errorText);
  if (!blocking) return;
  const r = deps.redis ?? conn();
  const now = (deps.now ?? Date.now)();
  const key = blockedKey(organizationId);
  const info: BlockedInfo = { since: now, lastSeen: now, code: blocking.code, reason: blocking.reason, sample: String(errorText).slice(0, 300) };
  try {
    // NX: solo el PRIMER fallo del incidente alerta; los siguientes solo refrescan el TTL.
    const claimed = await r.set(key, JSON.stringify(info), "EX", TTL_SECONDS, "NX");
    if (claimed !== "OK") {
      const prevRaw = await r.get(key);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw) as BlockedInfo;
        prev.lastSeen = now;
        await r.set(key, JSON.stringify(prev), "EX", TTL_SECONDS);
      }
      return;
    }
    const record = deps.record ?? recordEventReal;
    const notify = deps.notifyOwner ?? notifyOwnerReal;
    const ops = deps.ops ?? opsAlert;
    const resumen = `WhatsApp dejó de enviar: ${blocking.reason} (Meta #${blocking.code}). Los recordatorios/confirmaciones no se entregan hasta resolverlo en Meta.`;
    console.error(`🚨 ${resumen} org=${organizationId}`);
    const { subject, html } = blockedEmail(info);
    await record(organizationId, "error", "whatsapp.sending_blocked", resumen, info).catch((e) => console.error("✖ record sending_blocked:", (e as Error).message));
    await notify(organizationId, subject, html).catch((e) => console.error("✖ correo sending_blocked:", (e as Error).message));
    await ops({ summary: `WhatsApp sin enviar (Meta #${blocking.code})`, description: `Org ${organizationId}: ${resumen}`, severity: "critical" }).catch(() => undefined);
  } catch (err) {
    console.error("✖ observeSendFailure:", (err as Error).message);
  }
}

/**
 * Un mensaje se volvió a ENTREGAR. Si había un incidente de bloqueo abierto, lo cierra y
 * avisa la recuperación UNA sola vez. Llamar best-effort en los estados delivered/read.
 */
export async function observeSendSuccess(organizationId: string, deps: SendHealthDeps = {}): Promise<void> {
  const enabled = deps.enabled ?? getEnv().NODE_ENV === "production";
  if (!enabled) return;
  const r = deps.redis ?? conn();
  const key = blockedKey(organizationId);
  try {
    const existed = await r.get(key);
    if (!existed) return; // caso normal: nunca estuvo bloqueado.
    // DEL atómico: solo quien efectivamente borra la marca emite el aviso de recuperación.
    const removed = await r.del(key);
    if (removed !== 1) return;
    const info = JSON.parse(existed) as BlockedInfo;
    const downMin = Math.max(1, Math.round(((deps.now ?? Date.now)() - info.since) / 60000));
    const record = deps.record ?? recordEventReal;
    const notify = deps.notifyOwner ?? notifyOwnerReal;
    const ops = deps.ops ?? opsAlert;
    const resumen = `WhatsApp volvió a enviar mensajes (estuvo bloqueado ~${downMin} min por ${info.reason}).`;
    console.log(`✅ ${resumen} org=${organizationId}`);
    const html = `<div style="font-family:system-ui,Arial;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#15803d">WhatsApp volvió a enviar mensajes</h2><p>${resumen} Ya no necesitas hacer nada.</p></div>`;
    await record(organizationId, "ok", "whatsapp.sending_recovered", resumen, info).catch((e) => console.error("✖ record sending_recovered:", (e as Error).message));
    await notify(organizationId, "✅ WhatsApp volvió a enviar mensajes", html).catch((e) => console.error("✖ correo sending_recovered:", (e as Error).message));
    await ops({ summary: "WhatsApp volvió a enviar", description: `Org ${organizationId}: ${resumen}`, severity: "info" }).catch(() => undefined);
  } catch (err) {
    console.error("✖ observeSendSuccess:", (err as Error).message);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
