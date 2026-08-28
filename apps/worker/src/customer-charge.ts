/**
 * Cobro del TENANT a SUS clientes vía Flow (cuenta Flow del propio tenant): crea un
 * link de pago (payment/create) por el monto exacto. Reutiliza la firma de Flow del
 * proveedor de suscripciones. El worker es quien lo llama desde la tool enviarLinkDePago.
 */
import { flowSign } from "./subscription-billing/flow-provider";

export interface TenantFlowCfg {
  apiKey: string;
  secretKey: string;
  baseUrl: string; // https://www.flow.cl/api (prod) | https://sandbox.flow.cl/api
}

export async function createFlowPaymentLink(
  cfg: TenantFlowCfg,
  input: { commerceOrder: string; subject: string; amount: number; currency: string; email: string; urlConfirmation: string; urlReturn: string },
): Promise<{ ok: boolean; url?: string; token?: string; error?: string }> {
  const params: Record<string, string> = {
    apiKey: cfg.apiKey,
    commerceOrder: input.commerceOrder,
    subject: input.subject.slice(0, 100),
    currency: input.currency,
    amount: String(Math.round(input.amount)),
    email: input.email,
    urlConfirmation: input.urlConfirmation,
    urlReturn: input.urlReturn,
  };
  params.s = flowSign(params, cfg.secretKey);
  try {
    const res = await fetch(`${cfg.baseUrl}/payment/create`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const r: any = await res.json().catch(() => ({}));
    if (r?.url && r?.token) return { ok: true, url: `${r.url}?token=${r.token}`, token: String(r.token) };
    return { ok: false, error: r?.message ?? `Flow no devolvió el link (code ${r?.code ?? "?"})` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
