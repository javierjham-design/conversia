// Same-origin: Next reescribe /backend/* hacia la API (ver next.config.mjs).
// Sin URL inyectada en build y sin CORS.
export const API_URL = "/backend";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("conversia_token");
}

export function setToken(token: string) {
  window.localStorage.setItem("conversia_token", token);
}

export function clearToken() {
  window.localStorage.removeItem("conversia_token");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== "undefined") {
    clearToken();
    window.location.href = "/login";
    throw new Error("No autenticado");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}
