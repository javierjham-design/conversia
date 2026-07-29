import { promises as dns } from "node:dns";
import { renderVars } from "@conversia/workflows";

/** IPs internas/privadas/loopback/link-local/metadata que NO se pueden llamar. */
export function isBlockedIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "127.0.0.1" || v === "::1" || v === "0.0.0.0" || v === "::") return true;
  if (v === "169.254.169.254") return true; // metadata de nube (AWS/GCP/Azure)
  if (v.startsWith("10.") || v.startsWith("192.168.") || v.startsWith("169.254.")) return true;
  const m = v.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true; // 172.16.0.0/12
  if (v.startsWith("127.")) return true;
  // IPv6 loopback / ULA / link-local / IPv4-mapeada a loopback
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.")) return true;
  return false;
}

/**
 * Valida la URL antes de llamar (guard SSRF): solo http/https, sin localhost,
 * allowlist opcional del tenant, y resuelve el host a IP para bloquear rangos
 * internos (evita SSRF por hostname que apunta a una IP privada).
 */
export async function assertSafeUrl(rawUrl: string, allowlist?: string[]): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Solo se permiten URLs http/https");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("Destino no permitido (localhost)");
  if (allowlist && allowlist.length && !allowlist.some((d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()))) {
    throw new Error(`Dominio no permitido: ${host}`);
  }
  let address: string;
  try {
    ({ address } = await dns.lookup(host));
  } catch {
    throw new Error(`No se pudo resolver ${host}`);
  }
  if (isBlockedIp(address)) throw new Error(`Destino no permitido (IP interna ${address})`);
  return u;
}

export interface HttpNodeConfig {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowlist?: string[];
  /** { nombreVariable: "ruta.en.el.json" } — mapea la respuesta a variables del flujo. */
  responseMapping?: Record<string, string>;
}

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Ejecuta una petición HTTP con guard SSRF y mapea la respuesta JSON a variables.
 * SSRF/URL inválida → lanza (falla el nodo). Errores de red/HTTP → NO lanzan; se
 * exponen como __http_ok / __http_status / __http_error para poder ramificar.
 */
export async function callHttp(config: HttpNodeConfig, vars: Record<string, string>): Promise<Record<string, string>> {
  const url = renderVars(String(config.url ?? ""), vars);
  const u = await assertSafeUrl(url, config.allowlist); // lanza si no es seguro
  const method = (config.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, val] of Object.entries(config.headers ?? {})) headers[k] = renderVars(String(val), vars);
  const body = config.body ? renderVars(String(config.body), vars) : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(config.timeoutMs ?? 10000), 30000));
  const out: Record<string, string> = {};
  try {
    const res = await fetch(u.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "error", // no seguir redirects → evita SSRF por redirección
      signal: controller.signal,
    });
    out["__http_status"] = String(res.status);
    out["__http_ok"] = res.ok ? "true" : "false";
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    for (const [name, path] of Object.entries(config.responseMapping ?? {})) {
      const v = json != null ? getPath(json, path) : undefined;
      out[name] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  } catch (err) {
    out["__http_ok"] = "false";
    out["__http_error"] = (err as Error).message.slice(0, 200);
  } finally {
    clearTimeout(timeout);
  }
  return out;
}
