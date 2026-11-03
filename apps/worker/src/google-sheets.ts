import { withTenant } from "@conversia/database";
import { canUseFeature } from "@conversia/config";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * Google Sheets: agrega filas a una planilla del tenant (paso de workflow
 * "Agregar fila a Google Sheets"). Usa el mismo OAuth de Google que Calendar.
 * 429 (cuota) se relanza para que BullMQ aplique el backoff exponencial.
 */

export async function appendSheetRow(
  organizationId: string,
  payload: { spreadsheetId: string; sheetName: string; values: string[] },
): Promise<void> {
  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "google", type: status === "ok" ? "sheets.appended" : "sheets.error", status, message },
      }),
    ).catch(() => undefined);

  // Desde que los permisos se piden por separado, una cuenta puede tener Calendar y NO
  // Sheets. Sin esto Google contesta 403 "insufficient scope" y en el panel se leía como
  // "sin permiso sobre la planilla" — mandando al dueño a revisar la planilla equivocada.
  const conn = await withTenant(organizationId, (tx) =>
    tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" }, select: { config: true } }),
  );
  if (conn && !canUseFeature(conn.config, "sheets")) {
    await log("error", "Google Sheets: la cuenta conectada no dio permiso de planillas. Entra a Integraciones › Google Sheets y vuelve a conectar para autorizarlo.");
    return; // reintentar no agrega permisos
  }

  let token: string;
  try {
    token = await getFreshOAuthToken(organizationId, "google");
  } catch (err) {
    if (err instanceof NoConnectionError || err instanceof ReauthorizeError) return; // reintento inútil
    throw err;
  }

  const range = encodeURIComponent(`${payload.sheetName || "Hoja 1"}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(payload.spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [payload.values] }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (res.status === 429) {
    await log("error", "Google Sheets: cuota excedida (429); se reintentará");
    throw new Error("sheets 429");
  }
  if (!res.ok) {
    const detail = res.status === 404 ? "planilla no encontrada (revisa el ID)" : res.status === 403 ? "sin permiso sobre la planilla" : `error ${res.status}`;
    await log("error", `Google Sheets: ${detail}`);
    // 4xx de configuración no se arreglan reintentando; 5xx sí.
    if (res.status >= 500) throw new Error(`sheets ${res.status}`);
    return;
  }
  await withTenant(organizationId, (tx) =>
    tx.integrationConnection.updateMany({ where: { organizationId, provider: "google" }, data: { lastSyncAt: new Date() } }),
  ).catch(() => undefined);
  await log("ok", "Fila agregada en Google Sheets");
}
