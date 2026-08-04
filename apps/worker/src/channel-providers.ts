import { getEnv, withAppSecretProof } from "@conversia/config";
import type { ChannelProvider, ChannelSendOptions, ChannelSendResult, OutboundMessage } from "@conversia/types";
import { ChannelAuthError } from "./channel-auth";

/** Mock: imprime el mensaje saliente. Permite E2E sin credenciales de Meta. */
export class MockChannelProvider implements ChannelProvider {
  readonly kind = "mock";

  async send(phoneNumberId: string, message: OutboundMessage): Promise<ChannelSendResult> {
    const externalId = `mock-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`📤 [mock:${phoneNumberId}] → ${message.to}: ${message.text ?? `[${message.type}]`}`);
    return { externalId };
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
      // Token inválido/vencido/revocado → error tipado para que el llamador
      // marque el canal en estado "error" (banner Reautorizar) sin reintentos.
      if (res.status === 401 || text.includes('"code":190')) {
        throw new ChannelAuthError(`Meta send ${res.status}: ${text.slice(0, 300)}`);
      }
      throw new Error(`Meta send ${res.status}: ${text.slice(0, 500)}`);
    }
    const data: any = await res.json();
    return { externalId: data?.messages?.[0]?.id ?? null, raw: data };
  }
}

let provider: ChannelProvider | undefined;

export function getChannelProvider(): ChannelProvider {
  if (!provider) {
    provider = getEnv().WHATSAPP_PROVIDER === "meta" ? new MetaChannelProvider() : new MockChannelProvider();
  }
  return provider;
}
