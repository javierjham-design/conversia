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

// §10.1: un 401 en una llamada de AUTENTICACIÓN (login, registro, MFA, invitación) o estando ya
// en /login NO debe redirigir ni recargar la página — el formulario debe MOSTRAR el error del
// backend (antes recargaba y el cliente veía el formulario vacío, peor aún con MFA). En el resto
// (sesión vencida navegando el panel) sí se limpia el token y se va al login: comportamiento
// histórico de TuBot, intacto.
const AUTH_API_PATHS = ["/auth/login", "/auth/register", "/auth/mfa/", "/auth/accept-invite", "/auth/invite"];
export function shouldRedirectOn401(path: string, pathname: string | null | undefined): boolean {
  if (AUTH_API_PATHS.some((p) => path.startsWith(p))) return false;
  if (pathname === "/login") return false;
  return true;
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
  if (res.status === 401 && typeof window !== "undefined" && shouldRedirectOn401(path, window.location.pathname)) {
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
