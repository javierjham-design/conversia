/**
 * @conversia/config — Carga y validación de variables de entorno.
 * Falla temprano y con mensajes claros si falta configuración crítica.
 */
import { createHmac } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Carga .env desde la raíz del monorepo (o cwd) sin sobreescribir el entorno real
loadDotenv();
loadDotenv({ path: "../../.env" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/conversia?schema=public"),
  DIRECT_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  API_PORT: z.coerce.number().default(4000),
  WEB_URL: z.string().default("http://localhost:3000"),
  API_URL: z.string().default("http://localhost:4000"),
  JWT_SECRET: z.string().default("dev-secret-change-me"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  JWT_ISSUER: z.string().default("conversia"),
  JWT_AUDIENCE: z.string().default("conversia-api"),
  CREDENTIALS_ENCRYPTION_KEY: z.string().length(64).default("0".repeat(64)),

  // --- Rate limiting (fuerza bruta / credential stuffing / abuso) ---
  LOGIN_MAX_PER_WINDOW: z.coerce.number().default(20),
  LOGIN_WINDOW_SECONDS: z.coerce.number().default(900),
  API_MAX_PER_MINUTE: z.coerce.number().default(600),

  // --- Controles de IA (LLM Top 10: consumo, kill switch) ---
  AI_GLOBAL_KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AI_DAILY_TOKEN_BUDGET_PER_ORG: z.coerce.number().default(3_000_000), // 0 = ilimitado

  AI_PROVIDER: z.enum(["anthropic", "openai", "mock"]).default("openai"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
  AI_CLASSIFIER_MODEL: z.string().default("gpt-4o-mini"),
  AI_TRANSCRIBE_MODEL: z.string().default("whisper-1"), // notas de voz de WhatsApp (OpenAI)
  // Email transaccional (Resend). Vacío = no se envían correos (fallback manual).
  RESEND_API_KEY: z.string().optional().default(""),
  RESEND_FROM: z.string().default("TuBot <no-reply@tubot.cl>"),
  EMBEDDINGS_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  OPENAI_API_KEY: z.string().optional().default(""),
  // Inicio de sesión con Google (ID token verificado server-side; el client id es público)
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  // OAuth por tenant para Google Calendar/Sheets (app de plataforma; ver docs/GUIA_OAUTH_GOOGLE.md)
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().default(""),
  // OAuth por tenant para HubSpot (ver docs/GUIA_OAUTH_HUBSPOT.md)
  HUBSPOT_CLIENT_ID: z.string().optional().default(""),
  HUBSPOT_CLIENT_SECRET: z.string().optional().default(""),

  // Flow (Chile / CLP) — Stripe ya está definido más abajo. Vacías = mock en dev.
  FLOW_API_KEY: z.string().optional().default(""),
  FLOW_SECRET_KEY: z.string().optional().default(""),
  FLOW_BASE_URL: z.string().default("https://sandbox.flow.cl/api"),

  // Lemon Squeezy (Merchant of Record, USD/internacional). El variant por plan se
  // guarda en el plan (features.lsVariantId). Secretos SOLO por entorno.
  LEMONSQUEEZY_API_KEY: z.string().optional().default(""),
  LEMONSQUEEZY_STORE_ID: z.string().optional().default(""),
  LEMONSQUEEZY_WEBHOOK_SECRET: z.string().optional().default(""),

  // Seguridad del Super Admin (Fase A). Vacías = sin restricción extra (defaults seguros).
  SUPER_ADMIN_SESSION_SECRET: z.string().optional().default(""), // separa del JWT_SECRET de tenant
  SUPER_ADMIN_ALLOWED_IPS: z.string().optional().default(""), // CSV; vacío = sin allowlist
  SUPER_ADMIN_MFA_ISSUER: z.string().default("TuBot.cl"),
  // MFA obligatorio para admins de plataforma: sin él, solo se puede llegar a
  // /platform/auth/* (login + enrolar MFA); el resto del panel queda bloqueado.
  SUPER_ADMIN_REQUIRE_MFA: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  SUPER_ADMIN_SESSION_HOURS: z.coerce.number().default(4),
  PUBLIC_PRICING_CACHE_TTL: z.coerce.number().default(300),

  WHATSAPP_PROVIDER: z.enum(["meta", "mock"]).default("mock"),
  /** Token requerido para inyectar mensajes por canales mock (simulador). */
  MOCK_INBOUND_TOKEN: z.string().default("dev-mock-inbound-token"),
  /** Opcional: protege /health/status (header x-monitor-token) para el monitor externo. */
  MONITOR_TOKEN: z.string().optional().default(""),
  META_APP_SECRET: z.string().optional().default(""),
  META_VERIFY_TOKEN: z.string().default("conversia-verify-token-dev"),
  META_ACCESS_TOKEN: z.string().optional().default(""),
  META_GRAPH_VERSION: z.string().default("v21.0"),
  // Embedded Signup (onboarding self-service tipo Respond): app id + id de configuración
  META_APP_ID: z.string().optional().default(""),
  META_CONFIG_ID: z.string().optional().default(""),
  // featureType del Embedded Signup: "" = flujo completo (permite CREAR una WABA
  // nueva + número, o usar una existente). Otros: "only_waba_sharing" (solo
  // compartir una WABA existente), "whatsapp_business_app_onboarding".
  META_ES_FEATURE_TYPE: z.string().optional().default(""),

  SCHEDULING_PROVIDER: z.enum(["mock", "clariva"]).default("mock"),
  CLARIVA_BASE_URL: z.string().default("http://localhost:4010"),
  CLARIVA_API_KEY: z.string().default("dev-clariva-key"),
  CLARIVA_WEBHOOK_SECRET: z.string().default("dev-clariva-webhook-secret"),

  WORKER_CONCURRENCY: z.coerce.number().default(5),
  SCHEDULER_POLL_MS: z.coerce.number().default(15000),
  MOCK_CLARIVA_PORT: z.coerce.number().default(4010),

  // --- Facturación / pasarela de pago (opcional; mock si vacío) ---
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Configuración de entorno inválida:\n${issues}`);
    }
    cached = parsed.data;
    if (cached.NODE_ENV === "production") {
      if (cached.JWT_SECRET === "dev-secret-change-me") {
        throw new Error("JWT_SECRET debe definirse en producción");
      }
      if (cached.CREDENTIALS_ENCRYPTION_KEY === "0".repeat(64)) {
        throw new Error("CREDENTIALS_ENCRYPTION_KEY debe definirse en producción");
      }
    }
  }
  return cached;
}

/**
 * `appsecret_proof` = HMAC-SHA256 del access_token con el App Secret de Meta, en
 * hex. Meta lo exige en las llamadas server-side a Graph cuando el ajuste
 * "Require app secret proof for server API calls" está activo. Lo enviamos
 * SIEMPRE (aunque el toggle esté apagado; Meta lo acepta sin problema), así el
 * día que se active en el dashboard no se rompe ninguna llamada en producción.
 * Sin App Secret o sin token configurados devuelve "" (no rompe en desarrollo).
 */
export function metaAppSecretProof(accessToken: string, appSecret: string = getEnv().META_APP_SECRET): string {
  if (!appSecret || !accessToken) return "";
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/**
 * Añade `appsecret_proof` a una URL de Graph (respeta si ya tiene query y es
 * idempotente). Úsalo para llamadas que pasan el token por query string.
 */
export function withAppSecretProof(url: string, accessToken: string, appSecret?: string): string {
  const proof = metaAppSecretProof(accessToken, appSecret);
  if (!proof || url.includes("appsecret_proof=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}appsecret_proof=${proof}`;
}
