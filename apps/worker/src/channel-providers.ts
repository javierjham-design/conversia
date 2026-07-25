import { getEnv } from "@conversia/config";
import type { ChannelProvider, ChannelSendResult, OutboundMessage } from "@conversia/types";

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

  async send(phoneNumberId: string, message: OutboundMessage): Promise<ChannelSendResult> {
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
    } else {
      body.type = "text";
      body.text = { body: message.text ?? "" };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
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
