import { getEnv, withAppSecretProof } from "@conversia/config";

/**
 * Engancha un número de WhatsApp Cloud a nuestra app de Meta, con dos pasos que
 * SIEMPRE deben ir juntos al conectar un número:
 *  1) `subscribed_apps` sobre el WABA → recibir webhooks ENTRANTES.
 *  2) `register` sobre el número → poder ENVIAR (sin esto Meta responde
 *     #133010 "account is not registered" al mandar el primer mensaje).
 *
 * Antes esto SOLO lo hacía el Embedded Signup; la conexión MANUAL lo saltaba y
 * dejaba el canal a medias: no llegaban entrantes (hasta suscribir a mano) y el
 * envío fallaba con #133010. Best-effort: no lanza (el canal se crea igual),
 * pero devuelve avisos legibles para mostrarlos al usuario.
 *
 * `fetchImpl` se inyecta en tests; en producción usa el `fetch` global.
 */
export async function subscribeAndRegisterWhatsapp(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const v = getEnv().META_GRAPH_VERSION;
  const warnings: string[] = [];

  // 1) Suscribir la app al WABA (webhooks entrantes).
  try {
    const res = await fetchImpl(
      withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken),
      { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
    );
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!res.ok || json?.error) {
      warnings.push(
        `No se pudo suscribir la app al WABA (mensajes entrantes): ${json?.error?.message ?? `HTTP ${res.status}`}. Los mensajes que te escriban podrían no llegar.`,
      );
    }
  } catch (e) {
    warnings.push(`No se pudo suscribir la app al WABA (mensajes entrantes): ${(e as Error).message}`);
  }

  // 2) Registrar el número para Cloud API (necesario para ENVIAR; ver #133010).
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  try {
    const res = await fetchImpl(
      withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(phoneNumberId)}/register`, accessToken),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    // "Ya registrado" es benigno (idempotente): no se cuenta como error.
    const msg = String(json?.error?.message ?? "");
    const alreadyRegistered = /already/i.test(msg) || json?.error?.code === 133005;
    if ((!res.ok || json?.error) && !alreadyRegistered) {
      warnings.push(
        `No se pudo registrar el número para Cloud API (necesario para ENVIAR; error Meta #133010): ${json?.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
  } catch (e) {
    warnings.push(`No se pudo registrar el número para Cloud API: ${(e as Error).message}`);
  }

  return warnings;
}
