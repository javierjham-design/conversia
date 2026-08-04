import { createHash } from "node:crypto";
import { getEnv, withAppSecretProof } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";
import type { CapiJob } from "@conversia/types";

/** Normaliza y hashea PII según la especificación de Meta CAPI (SHA-256). */
function hashPhone(phone: string): string {
  const normalized = phone.replace(/[^\d]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Envía un evento a Meta Conversions API según las reglas del tenant.
 * Sin credenciales o dataset → registra el error honesto en la actividad.
 */
export async function processCapiJob(job: CapiJob): Promise<void> {
  const env = getEnv();
  const { organizationId, source } = job;

  const config = await withTenant(organizationId, async (tx) => {
    const mapping = await tx.metaEventMapping.findUnique({ where: { organizationId } });
    if (!mapping) return null;
    const rules = (mapping.rules as any[]) ?? [];
    const rule = rules.find((r) => r?.active && r?.source === source);
    const connection = await tx.metaBusinessConnection.findUnique({ where: { organizationId } });
    let token = env.META_ACCESS_TOKEN || "";
    if (connection?.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } });
      if (cred) token = decryptCredential(cred.ciphertext);
    }
    return { mapping, rule, token, mode: connection?.mode ?? null };
  });

  const log = (status: string, message: string, payload: Record<string, unknown> = {}) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "capi", type: status === "ok" ? "capi.sent" : "capi.error", status: status === "ok" ? "ok" : "error", message, payload: payload as object },
      }),
    );

  // Modo DIRECTO: el nodo de workflow define el evento; no requiere regla.
  const eventName: string | undefined = job.eventName ?? config?.rule?.dest;
  if (!config) {
    await log("error", "Meta no está configurado (dataset/token)");
    return;
  }
  if (!eventName) {
    await log("error", `Sin regla activa para "${source}"`);
    return;
  }
  if (!config.mapping.datasetId) {
    await log("error", "Falta configurar el dataset de conversiones");
    return;
  }
  if (config.mode === "MOCK") {
    await log("ok", `[SIMULADO] ${source} → ${eventName} (conexión de desarrollo, no se envió a Meta)`, {
      simulated: true,
      dest: eventName,
    });
    return;
  }
  if (!config.token) {
    await log("error", "Sin access token de Meta: conecta Meta o define META_ACCESS_TOKEN");
    return;
  }

  const value = job.eventName ? job.value ?? null : config.rule?.value ?? null;
  const currency = (job.eventName ? job.currency : config.rule?.currency) ?? "CLP";
  const eventPayload: Record<string, unknown> = {
    event_name: eventName,
    event_time: Math.floor(new Date(job.occurredAt).getTime() / 1000),
    action_source: "chat",
    event_id: `${organizationId}:${source}:${job.leadId ?? job.contactPhone ?? "anon"}:${job.occurredAt}`,
    user_data: {
      ...(job.contactPhone ? { ph: [hashPhone(job.contactPhone)] } : {}),
      ...(job.ctwaClid ? { ctwa_clid: job.ctwaClid } : {}),
    },
    ...(value ? { custom_data: { value, currency } } : {}),
  };
  const body: Record<string, unknown> = { data: [eventPayload] };
  if (job.test && config.mapping.testEventCode) body.test_event_code = config.mapping.testEventCode;

  try {
    const res = await fetch(
      withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${config.mapping.datasetId}/events?access_token=${encodeURIComponent(config.token)}`, config.token),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      await log("error", `Meta rechazó el evento: ${json?.error?.message ?? res.status}`, { dest: config.rule.dest });
      return;
    }
    await log("ok", `${source} → ${config.rule.dest}${job.test ? " (test)" : ""} · aceptados: ${json?.events_received ?? 1}`, {
      dest: config.rule.dest,
      test: Boolean(job.test),
    });
    // Espejo opcional a Google Analytics (switch "enviar también a Analytics").
    if (!job.test) {
      const { mirrorCapiToGa4 } = await import("./ga4.js");
      await mirrorCapiToGa4(organizationId, {
        name: eventName,
        value: value != null ? Number(value) : null,
        currency,
        contactKey: job.contactPhone ?? job.leadId ?? null,
      });
    }
  } catch (err) {
    await log("error", `Error de red hacia Meta: ${(err as Error).message.slice(0, 200)}`);
  }
}
