import { getAdminPrisma, withTenant } from "@conversia/database";
import { emitPlatformEvent } from "./platform-events";

/**
 * Campos de webhook de "salud" de la cuenta/número (no mensajes). Nos avisan
 * ANTES/cuando Meta baja la calidad, restringe la cuenta o rechaza plantillas —
 * el early warning para reaccionar antes de que corten el servicio.
 */
const HEALTH_FIELDS = new Set([
  "account_update", // restricciones, violaciones, baneos de la WABA
  "account_alerts",
  "phone_number_quality_update", // GREEN/YELLOW/RED del número
  "message_template_status_update",
  "message_template_quality_update",
  "business_capability_update", // cambios de límite de mensajería
  "phone_number_name_update",
]);

type Severity = "ok" | "warning" | "error";

function severityFor(field: string, value: any): Severity {
  const event = String(value?.event ?? value?.decision ?? "").toUpperCase();
  if (field === "account_update") {
    return /RESTRICT|VIOLAT|BAN|DISABL|DECERTIF|REJECT/.test(event) ? "error" : "warning";
  }
  if (field === "phone_number_quality_update") {
    if (/RED|FLAG|LOW|DOWNGRADE/.test(event)) return "error";
    if (/YELLOW|WARN/.test(event)) return "warning";
    return "ok";
  }
  return "ok";
}

function summarize(field: string, value: any): string {
  return [field, value?.event ?? value?.decision, value?.reason, value?.display_phone_number, value?.current_limit]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 480);
}

async function resolveOrgByWaba(wabaId?: string): Promise<string | null> {
  if (!wabaId) return null;
  const acc = await getAdminPrisma().whatsappAccount.findFirst({ where: { wabaId } });
  return acc?.organizationId ?? null;
}

/**
 * Registra los eventos de salud de WhatsApp en integration_events (visible en
 * Integraciones del tenant) y los emite como evento de plataforma (super-admin),
 * marcando severidad. Best-effort: nunca rompe el procesamiento de mensajes.
 */
export async function processMetaHealth(raw: any): Promise<void> {
  for (const entry of raw?.entry ?? []) {
    const wabaId: string | undefined = entry?.id;
    for (const change of entry?.changes ?? []) {
      const field: string | undefined = change?.field;
      if (!field || !HEALTH_FIELDS.has(field)) continue;
      const value = change?.value ?? {};
      const orgId = await resolveOrgByWaba(wabaId);
      if (!orgId) continue;
      const status = severityFor(field, value);
      const message = summarize(field, value);
      try {
        await withTenant(orgId, (tx) =>
          tx.integrationEvent.create({
            data: {
              organizationId: orgId,
              provider: "whatsapp",
              type: `whatsapp.${field}`,
              status,
              message,
              payload: (value ?? {}) as object,
            },
          }),
        );
        await emitPlatformEvent(orgId, `whatsapp.${field}`, { wabaId, status, ...value });
        if (status === "error") {
          console.warn(`🚨 WhatsApp salud [${field}] org=${orgId} waba=${wabaId}: ${message}`);
        }
      } catch (err) {
        console.error(`✖ Error registrando salud WhatsApp ${field}:`, (err as Error).message);
      }
    }
  }
}
