import { Injectable } from "@nestjs/common";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto";
import type { PaymentSettings } from "./payment-provider";

const K = {
  flowApiKey: "flow.apiKey",
  flowSecretKey: "flow.secretKey",
  flowBaseUrl: "flow.baseUrl",
  lsApiKey: "lemonsqueezy.apiKey",
  lsStoreId: "lemonsqueezy.storeId",
  lsWebhookSecret: "lemonsqueezy.webhookSecret",
};

/**
 * Credenciales de pasarelas guardadas en `platform_settings` (secretos CIFRADOS).
 * Se cargan desde el Super Admin; si falta una, cae a la variable de entorno.
 * NUNCA se devuelven los secretos al frontend (solo estado/valores públicos).
 */
@Injectable()
export class PaymentSettingsService {
  constructor(private prisma: PrismaService) {}

  private async raw(): Promise<Record<string, string>> {
    try {
      const rows = await this.prisma.admin.platformSetting.findMany();
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } catch {
      return {}; // tabla aún no migrada → cae a variables de entorno
    }
  }

  /** Credenciales efectivas (uso interno para cobrar/verificar webhooks). */
  async get(): Promise<PaymentSettings> {
    const s = await this.raw();
    const env = getEnv();
    const dec = (k: string, fb: string) => (s[k] ? decryptSecret(s[k]) : fb);
    const flowApiKey = dec(K.flowApiKey, env.FLOW_API_KEY);
    const flowSecretKey = dec(K.flowSecretKey, env.FLOW_SECRET_KEY);
    const flowBaseUrl = s[K.flowBaseUrl] || env.FLOW_BASE_URL;
    const lsApiKey = dec(K.lsApiKey, env.LEMONSQUEEZY_API_KEY);
    const lsStoreId = s[K.lsStoreId] || env.LEMONSQUEEZY_STORE_ID;
    const lsWebhookSecret = dec(K.lsWebhookSecret, env.LEMONSQUEEZY_WEBHOOK_SECRET);
    return {
      flow: flowApiKey && flowSecretKey ? { apiKey: flowApiKey, secretKey: flowSecretKey, baseUrl: flowBaseUrl } : undefined,
      lemonSqueezy: lsApiKey && lsStoreId ? { apiKey: lsApiKey, storeId: lsStoreId, webhookSecret: lsWebhookSecret } : undefined,
    };
  }

  /** Estado para la UI (sin secretos). `source`: db | env | null. */
  async status() {
    const s = await this.get();
    const raw = await this.raw();
    const env = getEnv();
    return {
      flow: {
        configured: !!s.flow,
        baseUrl: s.flow?.baseUrl ?? env.FLOW_BASE_URL,
        source: raw[K.flowApiKey] ? "db" : env.FLOW_API_KEY ? "env" : null,
      },
      lemonSqueezy: {
        configured: !!s.lemonSqueezy,
        storeId: s.lemonSqueezy?.storeId ?? null,
        hasWebhookSecret: !!s.lemonSqueezy?.webhookSecret,
        source: raw[K.lsApiKey] ? "db" : env.LEMONSQUEEZY_API_KEY ? "env" : null,
      },
    };
  }

  private async set(key: string, value: string, encrypt: boolean) {
    const stored = encrypt ? encryptSecret(value) : value;
    await this.prisma.admin.platformSetting.upsert({ where: { key }, update: { value: stored }, create: { key, value: stored } });
  }

  /** Guarda credenciales de Flow (solo los campos provistos). */
  async saveFlow(data: { apiKey?: string; secretKey?: string; baseUrl?: string }) {
    if (data.apiKey) await this.set(K.flowApiKey, data.apiKey, true);
    if (data.secretKey) await this.set(K.flowSecretKey, data.secretKey, true);
    if (data.baseUrl) await this.set(K.flowBaseUrl, data.baseUrl, false);
  }

  async saveLemonSqueezy(data: { apiKey?: string; storeId?: string; webhookSecret?: string }) {
    if (data.apiKey) await this.set(K.lsApiKey, data.apiKey, true);
    if (data.storeId) await this.set(K.lsStoreId, data.storeId, false);
    if (data.webhookSecret) await this.set(K.lsWebhookSecret, data.webhookSecret, true);
  }
}
