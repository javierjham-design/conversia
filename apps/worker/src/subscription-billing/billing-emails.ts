/**
 * Correos de cobranza (canal principal, irrenunciable) — remitente PLATAFORMA (TuBot)
 * hacia el/los administrador(es) del tenant. Español, claros, sin tono amenazante, con el
 * botón de pago siempre visible. No pasan por el SMTP del tenant (es cobranza nuestra).
 */
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

export type BillingEmailKind = "payment_failed" | "payment_succeeded" | "suspended" | "reactivated";

async function adminEmails(orgId: string): Promise<string[]> {
  const admin = getAdminPrisma();
  const members = await admin.organizationUser.findMany({
    where: { organizationId: orgId, active: true },
    select: { user: { select: { email: true } } },
    take: 10,
  });
  const emails = members.map((m) => m.user?.email).filter((e): e is string => !!e);
  return [...new Set(emails)];
}

function render(kind: BillingEmailKind, payUrl: string, data: Record<string, unknown>): { subject: string; html: string } {
  const btn = `<p style="margin:24px 0"><a href="${payUrl}" style="background:#0891b2;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Ir a pagar</a></p>`;
  const wrap = (title: string, body: string) => ({
    subject: title,
    html: `<div style="font-family:system-ui,Arial;max-width:520px;margin:auto;color:#0f172a"><h2 style="color:#0e7490">${title}</h2>${body}${btn}<p style="font-size:12px;color:#64748b">TuBot — atención conversacional</p></div>`,
  });
  switch (kind) {
    case "payment_failed": {
      const when = data.suspendAt ? new Date(String(data.suspendAt)).toLocaleString("es-CL") : "48 horas";
      return wrap("No pudimos procesar tu pago", `<p>Intentamos cobrar tu plan y el pago fue rechazado. <b>Tu servicio sigue activo</b>, y tienes hasta el <b>${when}</b> para regularizar antes de que se suspenda. Puedes pagar con la misma tarjeta u otra desde el botón.</p>`);
    }
    case "payment_succeeded":
      return wrap("Pago recibido ✔", `<p>Recibimos tu pago y tu plan quedó renovado. ¡Gracias! Puedes ver el comprobante en tu panel.</p>`);
    case "suspended":
      return wrap("Servicio suspendido por falta de pago", `<p>Suspendimos tu servicio por falta de pago. <b>Tus datos están intactos</b> y se conservan. Reactivas al instante pagando desde el botón.</p>`);
    case "reactivated":
      return wrap("¡Tu servicio está activo de nuevo!", `<p>Recibimos tu pago y reactivamos todo. Volvió a la normalidad, sin pérdida de configuración ni datos.</p>`);
  }
}

export async function sendBillingEmail(orgId: string, kind: BillingEmailKind, data: Record<string, unknown> = {}): Promise<void> {
  const env = getEnv();
  if (!env.RESEND_API_KEY) return; // sin remitente de plataforma no se envía (el panel ya avisó)
  const to = await adminEmails(orgId);
  if (!to.length) return;
  const payUrl = `${env.WEB_URL}/billing`;
  const { subject, html } = render(kind, payUrl, data);
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.RESEND_FROM, to, subject, html }),
    });
  } catch {
    /* el panel (integration_event) ya dejó constancia */
  }
}

/** Alerta al OWNER de la plataforma (cobro rechazado / suspensión / cancelación). */
export async function alertOwner(message: string): Promise<void> {
  const url = getEnv().OPS_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `💳 ${message}` }) });
  } catch {
    /* best-effort */
  }
}
