import { getEnv, withAppSecretProof } from "@conversia/config";

export interface OnboardStep {
  step: "subscribe" | "register" | "credit_share";
  ok: boolean;
  detail: string;
}

export interface OnboardResult {
  /** Avisos legibles para mostrar al usuario cuando algo NO quedó bien. */
  warnings: string[];
  /** Resultado detallado por paso (para el botón "Activar número"). */
  steps: OnboardStep[];
}

/**
 * Engancha un número de WhatsApp Cloud a nuestra app de Meta, con dos pasos que
 * SIEMPRE deben ir juntos al conectar un número:
 *  1) `subscribed_apps` sobre el WABA → recibir webhooks ENTRANTES.
 *  2) `register` sobre el número → poder ENVIAR (sin esto Meta responde
 *     #133010 "account is not registered" al mandar el primer mensaje) y sacar
 *     el número de "Pendiente" a "Conectado".
 *
 * Best-effort: NO lanza (el canal se crea/edita igual), pero devuelve el detalle
 * por paso + avisos legibles. Es idempotente: si el número ya estaba registrado
 * o la app ya estaba suscrita, se trata como éxito. Reintentable desde el botón
 * "Activar número" (p. ej. cuando el `register` falló porque el Nombre para
 * mostrar aún no estaba aprobado al momento de conectar).
 *
 * `fetchImpl` se inyecta en tests; en producción usa el `fetch` global.
 */
export async function subscribeAndRegisterWhatsapp(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OnboardResult> {
  const v = getEnv().META_GRAPH_VERSION;
  const warnings: string[] = [];
  const steps: OnboardStep[] = [];

  // 1) Suscribir la app al WABA (webhooks entrantes).
  try {
    const res = await fetchImpl(
      withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken),
      { method: "POST", headers: { authorization: `Bearer ${accessToken}` } },
    );
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!res.ok || json?.error) {
      const detail = json?.error?.message ?? `HTTP ${res.status}`;
      warnings.push(
        `No se pudo suscribir la app al WABA (mensajes entrantes): ${detail}. Los mensajes que te escriban podrían no llegar.`,
      );
      steps.push({ step: "subscribe", ok: false, detail });
    } else {
      steps.push({ step: "subscribe", ok: true, detail: "App suscrita al WABA — los mensajes entrantes ya llegan." });
    }
  } catch (e) {
    const detail = (e as Error).message;
    warnings.push(`No se pudo suscribir la app al WABA (mensajes entrantes): ${detail}`);
    steps.push({ step: "subscribe", ok: false, detail });
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
    // "Ya registrado" es benigno (idempotente): el número ya está activo. Meta lo
    // reporta con texto /already/ o el código 133005 (PIN ya configurado).
    const msg = String(json?.error?.message ?? "");
    const alreadyRegistered = /already/i.test(msg) || json?.error?.code === 133005;
    if ((!res.ok || json?.error) && !alreadyRegistered) {
      const detail = json?.error?.message ?? `HTTP ${res.status}`;
      warnings.push(
        `No se pudo registrar el número para Cloud API (necesario para ENVIAR y para sacarlo de "Pendiente"): ${detail}`,
      );
      steps.push({ step: "register", ok: false, detail });
    } else {
      steps.push({
        step: "register",
        ok: true,
        detail: alreadyRegistered
          ? "El número ya estaba registrado (activo para envío)."
          : "Número registrado para Cloud API — ya puede enviar y pasa de «Pendiente» a «Conectado».",
      });
    }
  } catch (e) {
    const detail = (e as Error).message;
    warnings.push(`No se pudo registrar el número para Cloud API: ${detail}`);
    steps.push({ step: "register", ok: false, detail });
  }

  // 3) OBO (On Behalf Of): adjuntar NUESTRA línea de crédito a la WABA del cliente,
  //    para que NO tenga que configurar su propio método de pago en Meta (evita el
  //    #131042). Solo si META_EXTENDED_CREDIT_ID está seteada. La llamada va sobre
  //    NUESTRA línea de crédito → se autentica con el token de sistema de TuBot
  //    (META_ACCESS_TOKEN), no con el del cliente. Best-effort + idempotente.
  const creditId = getEnv().META_EXTENDED_CREDIT_ID;
  if (creditId) {
    const creditToken = getEnv().META_ACCESS_TOKEN || accessToken;
    try {
      const currency = getEnv().META_CREDIT_CURRENCY;
      const url = `https://graph.facebook.com/${v}/${encodeURIComponent(creditId)}/whatsapp_credit_sharing_and_attach?waba_id=${encodeURIComponent(wabaId)}&waba_currency=${encodeURIComponent(currency)}`;
      const res = await fetchImpl(withAppSecretProof(url, creditToken), {
        method: "POST",
        headers: { authorization: `Bearer ${creditToken}` },
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
      const msg = String(json?.error?.message ?? "");
      const alreadyShared = /already|attached|exists/i.test(msg);
      if ((!res.ok || json?.error) && !alreadyShared) {
        const detail = json?.error?.message ?? `HTTP ${res.status}`;
        warnings.push(
          `No se pudo compartir la línea de crédito (OBO) con la WABA del cliente: ${detail}. Sin esto, el cliente debe configurar su propio pago en Meta para enviar plantillas.`,
        );
        steps.push({ step: "credit_share", ok: false, detail });
      } else {
        steps.push({
          step: "credit_share",
          ok: true,
          detail: alreadyShared
            ? "La línea de crédito ya estaba compartida con esta WABA."
            : "Línea de crédito compartida (OBO) — el cliente puede enviar sin configurar su propio pago.",
        });
      }
    } catch (e) {
      const detail = (e as Error).message;
      warnings.push(`No se pudo compartir la línea de crédito (OBO): ${detail}`);
      steps.push({ step: "credit_share", ok: false, detail });
    }
  }

  return { warnings, steps };
}
