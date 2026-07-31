import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

/**
 * Presets de API del tenant (tarjeta "API personalizada"): base URL + auth con
 * secreto CIFRADO + allowlist. El paso HTTP del canvas elige un preset en vez
 * de pegar tokens en cada nodo. Config en integration_connections
 * provider=api_presets: { presets: [{ id, name, baseUrl, authType, headerName,
 * credentialId }] }.
 */
export async function resolveApiPreset(
  organizationId: string,
  presetId: string,
): Promise<{ baseUrl: string; headers: Record<string, string>; allowlist: string[] } | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
    const presets = ((conn?.config as any)?.presets ?? []) as any[];
    const preset = presets.find((p) => p?.id === presetId);
    if (!preset?.baseUrl) return null;
    const headers: Record<string, string> = {};
    if (preset.credentialId) {
      const credential = await tx.integrationCredential.findUnique({ where: { id: String(preset.credentialId) } });
      if (credential) {
        try {
          const secret = decryptCredential(credential.ciphertext);
          if (preset.authType === "bearer") headers["authorization"] = `Bearer ${secret}`;
          else if (preset.authType === "header" && preset.headerName) headers[String(preset.headerName)] = secret;
        } catch {
          /* credencial ilegible → sin auth; la API destino responderá 401 */
        }
      }
    }
    let host = "";
    try {
      host = new URL(String(preset.baseUrl)).hostname;
    } catch {
      return null;
    }
    // La allowlist del preset ancla el paso HTTP a su dominio (anti-exfiltración).
    return { baseUrl: String(preset.baseUrl), headers, allowlist: [host] };
  });
}
