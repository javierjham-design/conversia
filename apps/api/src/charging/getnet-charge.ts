/**
 * Getnet Web Checkout (Chile) — helpers del lado API para CONFIRMAR el cobro (webhook) y
 * PROBAR credenciales. La creación de la sesión la hace el worker (getnet-charge.ts).
 * Patrón PlacetoPay/Evertec: auth WSSE (login/secretKey/tranKey), consulta de estado de
 * sesión y verificación de la firma de la notificación.
 *
 * NOTA: verificar nombres de campos/URLs con credenciales reales de Getnet al encender.
 */
import { createHash, randomBytes } from "node:crypto";

export interface GetnetChargeConfig {
  login: string;
  secretKey: string;
  baseUrl: string; // https://checkout.getnet.cl (prod) | https://checkout.test.getnet.cl (test)
}

function getnetAuth(cfg: GetnetChargeConfig) {
  const rawNonce = randomBytes(16);
  const seed = new Date().toISOString();
  const tranKey = createHash("sha256").update(Buffer.concat([rawNonce, Buffer.from(seed + cfg.secretKey, "utf8")])).digest("base64");
  return { login: cfg.login, tranKey, nonce: rawNonce.toString("base64"), seed };
}

/** Consulta el estado de una sesión (fuente de verdad para confirmar el pago). */
export async function getGetnetSessionStatus(cfg: GetnetChargeConfig, requestId: string): Promise<{ approved: boolean; amount: number | null; raw: any }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/api/session/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: getnetAuth(cfg) }),
    });
    const r: any = await res.json().catch(() => ({}));
    const sessionStatus = r?.status?.status;
    const tx = Array.isArray(r?.payment) ? r.payment[0] : undefined;
    const payStatus = tx?.status?.status;
    const amount = tx?.amount?.total != null ? Number(tx.amount.total) : null;
    return { approved: sessionStatus === "APPROVED" || payStatus === "APPROVED", amount, raw: r };
  } catch {
    return { approved: false, amount: null, raw: null };
  }
}

/** Prueba de credenciales: intenta consultar una sesión inexistente; si NO es error de auth, las llaves sirven. */
export async function getnetTestCredentials(cfg: GetnetChargeConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/api/session/0`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ auth: getnetAuth(cfg) }),
    });
    const r: any = await res.json().catch(() => ({}));
    const reason = String(r?.status?.reason ?? "");
    // 401/'PC' o mensajes de autenticación fallida => llaves malas; cualquier otra respuesta => auth OK.
    const authFail = res.status === 401 || /auth|autentic|login|tranKey|WSSE/i.test(String(r?.status?.message ?? ""));
    if (authFail) return { ok: false, detail: `Credenciales de Getnet inválidas: ${r?.status?.message ?? "autenticación rechazada"}` };
    return { ok: true, detail: `Credenciales de Getnet válidas (ambiente ${cfg.baseUrl.includes("test") ? "TEST" : "PRODUCCIÓN"}).${reason ? ` [${reason}]` : ""}` };
  } catch (err) {
    return { ok: false, detail: `No se pudo contactar a Getnet: ${(err as Error).message}` };
  }
}

/** Valida la firma de la notificación de Getnet: sha1(requestId + status + date + secretKey). */
export function verifyGetnetSignature(secretKey: string, requestId: string | number, status: string, date: string, signature: string): boolean {
  const expected = createHash("sha1").update(`${requestId}${status}${date}${secretKey}`).digest("hex");
  return expected.toLowerCase() === String(signature ?? "").toLowerCase();
}
