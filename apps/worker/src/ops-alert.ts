import { getEnv } from "@conversia/config";

/**
 * Alerta al SUPER ADMIN por el canal externo de operación (`OPS_ALERT_WEBHOOK_URL` →
 * BetterStack → correo + push + teléfono). Es el mecanismo real para "avisar al super admin"
 * (no existe un notifySuperAdmin en código; la consola in-app son las platform_exceptions).
 * No-op si no hay webhook configurado. Best-effort: nunca lanza.
 *
 * `dedupeSeconds` + `connection` (opcional): si se pasa un Redis, se dispara UNA sola vez por
 * `dedupeKey` dentro de la ventana (SET NX EX) — para no spamear en incidentes repetidos.
 */
export async function opsAlert(
  input: { summary: string; description: string; severity?: "info" | "warning" | "critical" },
  opts?: { connection?: { set: (k: string, v: string, ...args: unknown[]) => Promise<unknown> }; dedupeKey?: string; dedupeSeconds?: number },
): Promise<void> {
  const url = getEnv().OPS_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    if (opts?.connection && opts.dedupeKey) {
      const ok = await opts.connection.set(`ops-alert:${opts.dedupeKey}`, "1", "EX", opts.dedupeSeconds ?? 3600, "NX");
      if (ok === null) return; // ya se avisó dentro de la ventana
    }
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: input.summary, description: input.description, severity: input.severity ?? "critical" }),
    });
  } catch {
    /* best-effort */
  }
}
