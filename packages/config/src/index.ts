/**
 * @conversia/config — Carga y validación de variables de entorno.
 * Falla temprano y con mensajes claros si falta configuración crítica.
 */
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

  AI_PROVIDER: z.enum(["anthropic", "mock"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_DEFAULT_MODEL: z.string().default("claude-opus-4-8"),
  AI_CLASSIFIER_MODEL: z.string().default("claude-haiku-4-5"),
  EMBEDDINGS_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  OPENAI_API_KEY: z.string().optional().default(""),
  // Inicio de sesión con Google (ID token verificado server-side; el client id es público)
  GOOGLE_CLIENT_ID: z.string().optional().default(""),

  // Flow (Chile / CLP) — Stripe ya está definido más abajo. Vacías = mock en dev.
  FLOW_API_KEY: z.string().optional().default(""),
  FLOW_SECRET_KEY: z.string().optional().default(""),
  FLOW_BASE_URL: z.string().default("https://sandbox.flow.cl/api"),

  WHATSAPP_PROVIDER: z.enum(["meta", "mock"]).default("mock"),
  /** Token requerido para inyectar mensajes por canales mock (simulador). */
  MOCK_INBOUND_TOKEN: z.string().default("dev-mock-inbound-token"),
  META_APP_SECRET: z.string().optional().default(""),
  META_VERIFY_TOKEN: z.string().default("conversia-verify-token-dev"),
  META_ACCESS_TOKEN: z.string().optional().default(""),
  META_GRAPH_VERSION: z.string().default("v21.0"),
  // Embedded Signup (onboarding self-service tipo Respond): app id + id de configuración
  META_APP_ID: z.string().optional().default(""),
  META_CONFIG_ID: z.string().optional().default(""),

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
