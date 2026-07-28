import { getEnv } from "@conversia/config";

/**
 * Envío de email transaccional vía Resend (HTTP, sin SDK). Devuelve true si se
 * envió. Sin RESEND_API_KEY configurada → false (el llamador cae a un flujo
 * manual, p. ej. mostrar la contraseña temporal en pantalla).
 */
export async function sendEmail(opts: { to: string; subject: string; html: string; replyTo?: string }): Promise<boolean> {
  const env = getEnv();
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
