import { getEnv } from "@conversia/config";

/**
 * Envío de email transaccional vía Resend (HTTP, sin SDK). Devuelve true si se
 * envió. Sin key → false (el llamador cae a un flujo manual, p. ej. mostrar la
 * contraseña temporal en pantalla). `apiKey` permite la key POR MARCA
 * (brandOf().resendApiKey): las keys de Resend están restringidas por dominio.
 */
export async function sendEmail(opts: { to: string; subject: string; html: string; replyTo?: string; from?: string; apiKey?: string }): Promise<boolean> {
  const env = getEnv();
  const apiKey = opts.apiKey || env.RESEND_API_KEY;
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        // `from` configurable (remitente por marca); por defecto el verificado en Resend.
        from: opts.from ?? env.RESEND_FROM,
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
