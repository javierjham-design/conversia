import { fetchGraphWithProof, getEnv, withAppSecretProof } from "@conversia/config";
import type { ChannelProvider, ChannelSendOptions, ChannelSendResult, OutboundMessage, VerifyTokenResult } from "@conversia/types";
import { ChannelAuthError, ChannelConfigError, channelConfigNotice, TOKEN_INVALID_FAIL_TEXT } from "./channel-auth";
import { simWaTokenInvalid } from "./sim-token.js";

/** ¿El error de Meta es de token inválido/revocado (190 / OAuthException / 401)? */
export function isMetaAuthError(status: number, body: unknown, rawText: string): { auth: boolean; code?: number; subcode?: number } {
  const err = (body as { error?: { code?: number; type?: string; error_subcode?: number } } | null)?.error;
  if (err) {
    const auth = err.code === 190 || err.type === "OAuthException" || status === 401;
    return { auth, code: err.code, subcode: err.error_subcode };
  }
  // Sin JSON parseable: caer al texto crudo (compat).
  if (status === 401 || rawText.includes('"code":190')) return { auth: true, code: 190 };
  return { auth: false };
}

/** Mock: imprime el mensaje saliente. Permite E2E sin credenciales de Meta. */
export class MockChannelProvider implements ChannelProvider {
  readonly kind = "mock";

  async send(phoneNumberId: string, message: OutboundMessage): Promise<ChannelSendResult> {
    // SIMULACIÓN: con el flag Redis activo (para este número), el envío falla como un 190 real.
    if (await simWaTokenInvalid(phoneNumberId)) {
      throw new ChannelAuthError(`mock: simulated Meta 190 (token inválido) para ${phoneNumberId}`, TOKEN_INVALID_FAIL_TEXT);
    }
    const externalId = `mock-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`📤 [mock:${phoneNumberId}] → ${message.to}: ${message.text ?? `[${message.type}]`}`);
    return { externalId };
  }

  async verifyToken(input: { phoneNumberId: string; accessToken: string | null }): Promise<VerifyTokenResult> {
    // SIMULACIÓN: el chequeo activo ve el token muerto SIN tráfico cuando el flag aplica a este número.
    if (await simWaTokenInvalid(input.phoneNumberId)) return { ok: false, code: 190, detail: "mock: simulated invalid token" };
    return { ok: true };
  }
}

/** WhatsApp Cloud API oficial de Meta. */
export class MetaChannelProvider implements ChannelProvider {
  readonly kind = "meta";

  async send(phoneNumberId: string, message: OutboundMessage, options?: ChannelSendOptions): Promise<ChannelSendResult> {
    const env = getEnv();
    const url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${phoneNumberId}/messages`;
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.to,
    };
    if (message.type === "template" && message.templateName) {
      body.type = "template";
      body.template = {
        name: message.templateName,
        language: { code: message.templateLanguage ?? "es" },
        components: message.templateParams?.length
          ? [{ type: "body", parameters: message.templateParams.map((t) => ({ type: "text", text: t })) }]
          : undefined,
      };
    } else if ((message.type === "image" || message.type === "document" || message.type === "audio") && (message.mediaId || message.mediaUrl)) {
      // Media saliente: por id ya subido a Meta (preferido) o por link público.
      body.type = message.type;
      const media: Record<string, unknown> = message.mediaId ? { id: message.mediaId } : { link: message.mediaUrl };
      if (message.type === "image" && message.text) media.caption = message.text;
      if (message.type === "document") {
        if (message.text) media.caption = message.text;
        if (message.filename) media.filename = message.filename;
      }
      body[message.type] = media;
    } else {
      body.type = "text";
      body.text = { body: message.text ?? "" };
    }

    const token = options?.accessToken || env.META_ACCESS_TOKEN;
    const res = await fetch(withAppSecretProof(url, token), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
      // Token inválido/vencido/revocado (190 / OAuthException / 401) → error tipado: el llamador
      // marca el canal "error" (banner Reautorizar) + excepción crítica, SIN reintentos.
      const authErr = isMetaAuthError(res.status, parsed, text);
      if (authErr.auth) {
        throw new ChannelAuthError(`Meta send ${res.status} (code ${authErr.code ?? "?"}${authErr.subcode ? `/${authErr.subcode}` : ""}): ${text.slice(0, 300)}`);
      }
      // Errores de configuración del canal en Meta (nombre para mostrar, registro, pago…):
      // reintentar no ayuda; se marca el canal con un aviso claro.
      const notice = channelConfigNotice(text);
      if (notice) throw new ChannelConfigError(`Meta send ${res.status}: ${text.slice(0, 300)}`, notice);
      throw new Error(`Meta send ${res.status}: ${text.slice(0, 500)}`);
    }
    const data: any = await res.json();
    return { externalId: data?.messages?.[0]?.id ?? null, raw: data };
  }

  async verifyToken(input: { phoneNumberId: string; accessToken: string | null }): Promise<VerifyTokenResult> {
    const env = getEnv();
    const token = input.accessToken || env.META_ACCESS_TOKEN;
    if (!token) return { ok: false, detail: "sin token de envío configurado" };
    // Llamada barata: GET /{phone_number_id}?fields=id (no envía nada). Reusa el cliente Graph
    // compartido (doble app-secret fallback), más robusto que el fetch crudo del send.
    const url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${input.phoneNumberId}?fields=id`;
    try {
      const res = await fetchGraphWithProof(url, token);
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => "");
      const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const authErr = isMetaAuthError(res.status, parsed, text);
      return { ok: false, code: authErr.code, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    } catch (e) {
      // Fallo de red: NO afirmamos token muerto (evita falsos positivos por un bache de red).
      return { ok: true, detail: `verify skip (red): ${(e as Error).message}` };
    }
  }
}

let provider: ChannelProvider | undefined;

export function getChannelProvider(): ChannelProvider {
  if (!provider) {
    provider = getEnv().WHATSAPP_PROVIDER === "meta" ? new MetaChannelProvider() : new MockChannelProvider();
  }
  return provider;
}
