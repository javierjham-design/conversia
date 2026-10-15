import { getEnv, withAppSecretProof } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

/**
 * V2-7 — crea por Graph API las plantillas HSM del rubro al conectar el canal. Las WABA son
 * NUESTRAS (D3) → podemos crearlas (no el cliente a mano). Idempotente por (waba, nombre, idioma):
 * si ya existe en la WABA, no la re-crea. El estado (pendiente/aprobada/rechazada) lo refleja
 * syncOrgTemplates + el webhook message_template_status_update ya existentes. Best-effort: solo
 * corre si hay WABA + token (si no, no hace nada — p. ej. antes de conectar).
 */

export type HsmSpec = { name: string; language: string; category: "UTILITY" | "MARKETING"; bodyText: string; example?: string[] };

/** Set estándar de HSM (categoría UTILITY — reactivan la ventana de 24h). {{1}}=nombre negocio/cliente. */
export const STANDARD_HSM: HsmSpec[] = [
  { name: "cv_bienvenida", language: "es", category: "UTILITY", bodyText: "Hola, soy el asistente de {{1}}. Gracias por escribirnos — ¿en qué te puedo ayudar hoy?", example: ["tu negocio"] },
  { name: "cv_recordatorio_cita", language: "es", category: "UTILITY", bodyText: "Te recordamos tu hora en {{1}} para el {{2}}. Responde CONFIRMAR o REAGENDAR. ¡Te esperamos!", example: ["tu negocio", "mañana 15:00"] },
  { name: "cv_confirmacion_cita", language: "es", category: "UTILITY", bodyText: "¡Listo! Tu hora en {{1}} quedó agendada para el {{2}}. Si necesitas cambiarla, escríbenos por aquí.", example: ["tu negocio", "mañana 15:00"] },
  { name: "cv_reactivacion", language: "es", category: "UTILITY", bodyText: "Hola, en {{1}} queremos retomar tu atención. ¿Te gustaría agendar una hora? Estamos para ayudarte.", example: ["tu negocio"] },
];

function buildComponents(spec: HsmSpec) {
  return [{ type: "BODY", text: spec.bodyText, ...(spec.example ? { example: { body_text: [spec.example] } } : {}) }];
}

/** Crea las HSM estándar en la(s) WABA de la org. Devuelve cuántas intentó crear (nuevas). */
export async function createVerticalTemplates(organizationId: string): Promise<number> {
  const env = getEnv();
  let created = 0;
  const accounts = await withTenant(organizationId, (tx) => tx.whatsappAccount.findMany({ include: { phoneNumbers: true } }));
  for (const account of accounts) {
    const chIds = account.phoneNumbers.map((n) => n.channelConnectionId).filter(Boolean) as string[];
    if (chIds.length) {
      const active = await withTenant(organizationId, (tx) => tx.channelConnection.count({ where: { id: { in: chIds }, status: "active" } }));
      if (active === 0) continue;
    }
    let token = env.META_ACCESS_TOKEN || "";
    if (account.credentialId) {
      const cred = await withTenant(organizationId, (tx) => tx.integrationCredential.findUnique({ where: { id: account.credentialId! } }));
      if (cred) {
        try {
          token = decryptCredential(cred.ciphertext);
        } catch {
          /* global */
        }
      }
    }
    if (!token) continue;

    // Idempotencia: nombres ya existentes en nuestra tabla (poblada por syncOrgTemplates).
    const existing = await withTenant(organizationId, (tx) => tx.whatsappTemplate.findMany({ where: { accountId: account.id }, select: { name: true } })).catch(() => [] as { name: string }[]);
    const existingNames = new Set(existing.map((t) => t.name));

    for (const spec of STANDARD_HSM) {
      if (existingNames.has(spec.name)) continue;
      try {
        const res = await fetch(
          withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(account.wabaId)}/message_templates`, token),
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ name: spec.name, language: spec.language, category: spec.category, components: buildComponents(spec) }),
            signal: AbortSignal.timeout(20_000),
          },
        );
        const json: any = await res.json().catch(() => ({}));
        if (res.ok) {
          created++;
          // Registra el estado inicial (el webhook/sync lo actualizan a APPROVED/REJECTED).
          await withTenant(organizationId, (tx) =>
            tx.whatsappTemplate.upsert({
              where: { organizationId_accountId_name_language: { organizationId, accountId: account.id, name: spec.name, language: spec.language } },
              create: { organizationId, accountId: account.id, name: spec.name, language: spec.language, category: spec.category, status: String(json?.status ?? "PENDING"), body: { text: spec.bodyText } as object },
              update: { status: String(json?.status ?? "PENDING") },
            }),
          ).catch(() => undefined);
        } else {
          await withTenant(organizationId, (tx) =>
            tx.integrationEvent.create({ data: { organizationId, provider: "whatsapp", type: "template.create_error", status: "error", message: `Crear plantilla ${spec.name}: ${json?.error?.message ?? res.status}` } }),
          ).catch(() => undefined);
        }
      } catch (err) {
        console.error(`✖ createVerticalTemplates ${spec.name}:`, (err as Error).message);
      }
    }
  }
  return created;
}
