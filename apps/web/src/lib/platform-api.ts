// Cliente del panel de PLATAFORMA. Token separado del de tenant.
export const API_URL = "/backend";
const KEY = "conversia_platform_token";

export function getPlatformToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}
export function setPlatformToken(t: string) {
  window.localStorage.setItem(KEY, t);
}
export function clearPlatformToken() {
  window.localStorage.removeItem(KEY);
}

export async function padmin<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && typeof window !== "undefined") {
    clearPlatformToken();
    window.location.href = "/admin/login";
    throw new Error("No autenticado");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message ?? `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}
