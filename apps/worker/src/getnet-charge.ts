/**
 * Cobro del TENANT a SUS clientes vía GETNET (Web Checkout de Getnet Chile — patrón
 * PlacetoPay/Evertec). Crea una sesión de pago (POST /api/session) y devuelve la
 * `processUrl` (el link que se le envía al cliente). Lo llama la tool enviarLinkDePago
 * cuando el proveedor de cobros del tenant es "getnet".
 *
 * Auth WSSE: tranKey = base64(sha256(rawNonce + seed + secretKey)); se envía nonce=base64(rawNonce)
 * y seed=ISO8601 (no puede diferir más de 5 min del reloj de Getnet).
 *
 * NOTA: implementado según el manual de Getnet Web Checkout; los NOMBRES de campos de la
 * respuesta y las URLs base deben verificarse con credenciales reales de Getnet al encender
 * (igual que se hizo con Flow). Base: prod https://checkout.getnet.cl · test https://checkout.test.getnet.cl
 */
import { createHash, randomBytes } from "node:crypto";

export interface GetnetCfg {
  login: string;
  secretKey: string;
  baseUrl: string;
}

export function getnetAuth(cfg: GetnetCfg): { login: string; tranKey: string; nonce: string; seed: string } {
  const rawNonce = randomBytes(16);
  const seed = new Date().toISOString();
  const tranKey = createHash("sha256").update(Buffer.concat([rawNonce, Buffer.from(seed + cfg.secretKey, "utf8")])).digest("base64");
  return { login: cfg.login, tranKey, nonce: rawNonce.toString("base64"), seed };
}

export async function createGetnetSession(
  cfg: GetnetCfg,
  input: { reference: string; description: string; amount: number; currency: string; returnUrl: string; notificationUrl: string; ipAddress?: string },
): Promise<{ ok: boolean; url?: string; requestId?: string; error?: string }> {
  const body = {
    locale: "es_CL",
    auth: getnetAuth(cfg),
    payment: {
      reference: input.reference,
      description: input.description.slice(0, 250),
      amount: { currency: input.currency, total: Math.round(input.amount) },
    },
    expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    returnUrl: input.returnUrl,
    notificationUrl: input.notificationUrl,
    ipAddress: input.ipAddress ?? "127.0.0.1",
    userAgent: "TuBot",
  };
  try {
    const res = await fetch(`${cfg.baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const r: any = await res.json().catch(() => ({}));
    if (r?.status?.status === "OK" && r?.processUrl && r?.requestId != null) {
      return { ok: true, url: String(r.processUrl), requestId: String(r.requestId) };
    }
    return { ok: false, error: r?.status?.message ?? `Getnet no devolvió el link (status ${r?.status?.status ?? "?"})` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
