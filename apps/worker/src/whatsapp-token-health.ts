import type IORedis from "ioredis";
import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { markChannelAuthError, markChannelRecovered } from "./channel-auth.js";
import { getChannelProvider } from "./channel-providers.js";
import { decryptCredential } from "./credentials.js";
import { simWaTokenInvalid } from "./sim-token.js";

/**
 * CHEQUEO ACTIVO de los tokens de WhatsApp (cada 15 min, junto al canario). Cierra el hueco del
 * incidente 19-oct-2026: los tokens se invalidaron y nadie se enteró porque los ENVÍOS fallan uno
 * a uno mientras los webhooks entrantes siguen llegando. Aquí, SIN tráfico de por medio, cada
 * token de envío activo (y el global del Tech Provider) se valida con una llamada barata a Graph;
 * un 190 dispara la excepción crítica `token_invalido` + alerta al super admin, y la recuperación
 * se resuelve sola. El resultado se publica en Redis para /health y la consola del super admin.
 */
export const WHATSAPP_TOKEN_HEALTH_KEY = "conversia:health:whatsapp-token";

export interface DeadChannel {
  organizationId: string;
  channelConnectionId: string | null;
  phone: string | null;
  name: string | null;
  detail: string;
}
export interface TokenHealthSnapshot {
  ok: boolean;
  ts: number;
  globalOk: boolean;
  globalDetail?: string;
  checked: number;
  dead: DeadChannel[];
}

/** Un token se considera MUERTO solo ante un error de autenticación (190/401), no un bache de red. */
export function isDead(result: { ok: boolean; code?: number }): boolean {
  return !result.ok && (result.code === 190 || result.code === 401);
}

/** Corre el chequeo una vez: valida todos los canales + el token global y publica el snapshot. */
export async function runWhatsappTokenHealth(connection: IORedis): Promise<TokenHealthSnapshot> {
  const env = getEnv();
  const admin = getAdminPrisma();
  const provider = getChannelProvider();
  const dead: DeadChannel[] = [];
  let checked = 0;

  // Canales que ENVÍAN por WhatsApp (reales + MOCK del sim). Incluye "error" para detectar recuperación.
  // Resolución de token EN LOTE (unas pocas consultas, SIN una transacción withTenant por canal —
  // eso no escala: con cientos de canales el barrido tardaba minutos). Se arma el token de cada
  // canal en memoria, como resolveChannelAuth pero sin round-trip por canal.
  const channels = await admin.channelConnection.findMany({
    where: { type: { in: ["WHATSAPP_CLOUD", "MOCK"] }, status: { in: ["active", "error"] } },
    select: { id: true, organizationId: true, status: true, name: true },
  });
  const chIds = channels.map((c) => c.id);
  const [numbers, orgs] = await Promise.all([
    admin.whatsappPhoneNumber.findMany({ where: { channelConnectionId: { in: chIds } }, select: { phoneNumberId: true, channelConnectionId: true, accountId: true } }),
    admin.organization.findMany({ where: { id: { in: [...new Set(channels.map((c) => c.organizationId))] } }, select: { id: true, slug: true } }),
  ]);
  const accounts = numbers.length
    ? await admin.whatsappAccount.findMany({ where: { id: { in: [...new Set(numbers.map((n) => n.accountId))] } }, select: { id: true, credentialId: true } })
    : [];
  const credIds = accounts.map((a) => a.credentialId).filter((x): x is string => !!x);
  const creds = credIds.length ? await admin.integrationCredential.findMany({ where: { id: { in: credIds } }, select: { id: true, ciphertext: true } }) : [];
  const numByCh = new Map(numbers.map((n) => [n.channelConnectionId, n]));
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const credById = new Map(creds.map((c) => [c.id, c]));
  const slugById = new Map(orgs.map((o) => [o.id, o.slug]));

  function resolveToken(ch: { id: string; organizationId: string }): { phoneNumberId: string; accessToken: string | null } {
    const num = numByCh.get(ch.id);
    if (!num) return { phoneNumberId: `mock:${slugById.get(ch.organizationId) ?? ch.organizationId}`, accessToken: null };
    let accessToken: string | null = env.META_ACCESS_TOKEN || null;
    const acc = accById.get(num.accountId);
    if (acc?.credentialId) {
      const cr = credById.get(acc.credentialId);
      if (cr) { try { accessToken = decryptCredential(cr.ciphertext); } catch { /* ilegible → global */ } }
    }
    return { phoneNumberId: num.phoneNumberId, accessToken };
  }

  for (const ch of channels) {
    checked++;
    try {
      const { phoneNumberId, accessToken } = resolveToken(ch);
      const result = await provider.verifyToken({ phoneNumberId, accessToken });
      if (isDead(result)) {
        dead.push({ organizationId: ch.organizationId, channelConnectionId: ch.id, phone: phoneNumberId, name: ch.name, detail: result.detail ?? `code ${result.code}` });
        await markChannelAuthError(ch.organizationId, ch.id, result.detail ?? `verify code ${result.code}`, { phone: phoneNumberId, source: "health" });
      } else if (result.ok && ch.status === "error") {
        // Volvió a responder: reactiva el canal y resuelve la excepción.
        await markChannelRecovered(ch.organizationId, ch.id);
      }
    } catch (e) {
      // Un fallo al verificar un canal no debe tumbar el barrido de los demás.
      console.error(`wa-token-health channel ${ch.id}:`, (e as Error).message);
    }
  }

  // Token GLOBAL del Tech Provider (fallback de la plataforma). Mock: honra el flag de simulación.
  let globalOk = true;
  let globalDetail: string | undefined;
  try {
    if (provider.kind === "mock") {
      globalOk = !(await simWaTokenInvalid());
      if (!globalOk) globalDetail = "mock: simulated invalid global token";
    } else if (env.META_ACCESS_TOKEN) {
      const res = await fetchGraphWithProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/me?fields=id`, env.META_ACCESS_TOKEN);
      if (res.ok) {
        globalOk = true;
      } else {
        // Parsea el error real de Graph: NO todo 400 es un token muerto. Solo un error de
        // AUTENTICACIÓN (190/102/467 o 401) significa que el token global está caído y hay que
        // reemplazarlo. Un error de `appsecret_proof` quiere decir que el App Secret configurado
        // no corresponde a la app que emitió el token (el token puede estar VIVO) → NO es caída, y
        // no debe disparar el banner rojo de "envíos fallando". Cualquier otro 4xx tampoco se
        // afirma como caída (se reporta como "no verificado") para no generar falsos positivos.
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; error_subcode?: number; message?: string; type?: string } };
        const err = body.error ?? {};
        const code = typeof err.code === "number" ? err.code : undefined;
        const msg = err.message ?? `HTTP ${res.status}`;
        const authDead = code === 190 || code === 102 || code === 467 || res.status === 401;
        const isProof = /appsecret_proof/i.test(err.message ?? "");
        if (authDead) {
          globalOk = false;
          globalDetail = `token inválido — code ${code}${err.error_subcode ? `/${err.error_subcode}` : ""}: ${msg}`;
        } else if (isProof) {
          globalOk = true;
          globalDetail = `no verificado: el App Secret no coincide con la app del token (revisa META_APP_SECRET; el token podría estar bien)`;
        } else {
          globalOk = true;
          globalDetail = `no verificado — code ${code ?? "?"}: ${msg}`;
        }
      }
    }
  } catch (e) {
    // Bache de red: no afirmamos caída global (evita falsos positivos).
    globalDetail = `verify skip (red): ${(e as Error).message}`;
  }

  const snapshot: TokenHealthSnapshot = {
    ok: globalOk && dead.length === 0,
    ts: Date.now(),
    globalOk,
    globalDetail,
    checked,
    dead,
  };
  try {
    await connection.set(WHATSAPP_TOKEN_HEALTH_KEY, JSON.stringify(snapshot), "EX", 3600);
  } catch {
    /* best-effort */
  }
  if (!snapshot.ok) {
    console.warn(`⚠ wa-token-health: ${dead.length} canal(es) con token caído${globalOk ? "" : " + token GLOBAL caído"} (de ${checked} verificados)`);
  }
  return snapshot;
}

/** Programa el chequeo cada 15 min (como el canario), con una primera corrida ~40s tras el boot. */
export function startWhatsappTokenHealth(connection: IORedis): () => void {
  const every = setInterval(() => void runWhatsappTokenHealth(connection).catch((e) => console.error("wa-token-health:", e)), 15 * 60_000);
  every.unref?.();
  const first = setTimeout(() => void runWhatsappTokenHealth(connection).catch(() => undefined), 40_000);
  first.unref?.();
  return () => {
    clearInterval(every);
    clearTimeout(first);
  };
}
