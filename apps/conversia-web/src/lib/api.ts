/** Cliente HTTP mínimo contra la MISMA API de la plataforma (un backend, dos frontends). */
import { apiBase } from "./api-base";
const API = apiBase();

const TOKEN_KEY = "conversia_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    // Adjunta el código HTTP al error → la UI puede distinguir 404/403 (p. ej. ocultar la
    // burbuja del asistente en una cuenta que no es de la marca) de un fallo transitorio.
    const err = new Error(body.message ?? `Error ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}
