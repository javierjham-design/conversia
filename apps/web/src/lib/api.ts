// Same-origin: Next reescribe /backend/* hacia la API (ver next.config.mjs).
// Sin URL inyectada en build y sin CORS.
import { startAuthentication } from "@simplewebauthn/browser";

export const API_URL = "/backend";

const TOKEN_KEY = "conversia_token";
const REFRESH_KEY = "conversia_refresh";
// Plazo MÁXIMO de la sesión (ms epoch). Lo manda el servidor. Una SESIÓN DE APARATO (passkey P3)
// NO lo trae (no tiene techo) → ausente = "sin plazo", el refresh se sigue intentando.
const PLAZO_KEY = "conversia_session_until";

// localStorage puede lanzar (modo privado, cookies bloqueadas) → todo acceso va envuelto.
function lsGet(k: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* modo privado: la sesión vivirá solo en memoria de esta pestaña */
  }
}
function lsDel(k: string): void {
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}

export function getToken(): string | null {
  return lsGet(TOKEN_KEY);
}

/**
 * Reemplaza SOLO el access token: un login por CONTRASEÑA / Google / MFA de TuBot, que NO tiene
 * refresh. Borra el refresh y el plazo por si venían de una sesión de aparato anterior en este
 * navegador: dejarlos haría que una sesión normal intente renovarse con un refresh que ya no es suyo.
 */
export function setToken(token: string) {
  lsSet(TOKEN_KEY, token);
  lsDel(REFRESH_KEY);
  lsDel(PLAZO_KEY);
}

export function getRefreshToken(): string | null {
  return lsGet(REFRESH_KEY);
}

/** Lo que devuelve la API al abrir o renovar una sesión. */
export interface SesionDelServidor {
  token: string;
  refreshToken?: string | null;
  /** Techo absoluto en ISO. AUSENTE = sesión de aparato (sin techo) o sesión sin refresh. */
  sessionExpiresAt?: string | null;
}

/**
 * Guarda la sesión COMPLETA (access + refresh + plazo). El refresh es opcional: solo lo trae un
 * login por PASSKEY de TuBot (sesión de aparato, P3). Sin `sessionExpiresAt` (sin techo) se borra
 * el plazo → `plazoVencido` deja de cortar el refresh.
 */
export function setSession(s: SesionDelServidor) {
  lsSet(TOKEN_KEY, s.token);
  if (s.refreshToken) lsSet(REFRESH_KEY, s.refreshToken);
  else lsDel(REFRESH_KEY);
  const plazo = s.sessionExpiresAt ? Date.parse(s.sessionExpiresAt) : NaN;
  if (Number.isFinite(plazo)) lsSet(PLAZO_KEY, String(plazo));
  else lsDel(PLAZO_KEY);
}

/** Cerrar sesión = borrar los TRES datos (access, refresh y plazo). */
export function clearToken() {
  lsDel(TOKEN_KEY);
  lsDel(REFRESH_KEY);
  lsDel(PLAZO_KEY);
}

/** Plazo máximo de la sesión en ms epoch, o null si no lo sabemos (sesión de aparato = sin plazo). */
export function getSessionDeadline(): number | null {
  const raw = lsGet(PLAZO_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ¿Se pasó el plazo? Solo true con un plazo CONOCIDO y vencido: no saber nunca es "vencida". */
export function plazoVencido(plazo: number | null, nowMs: number = Date.now()): boolean {
  return plazo !== null && plazo <= nowMs;
}

// §10.1: un 401 en una llamada de AUTENTICACIÓN (login, registro, MFA, invitación, refresh) o
// estando ya en /login NO debe redirigir ni recargar la página — el formulario debe MOSTRAR el
// error del backend (antes recargaba y el cliente veía el formulario vacío, peor aún con MFA). En
// el resto (sesión vencida navegando el panel) sí se intenta renovar y, si no se puede, se va al
// login: comportamiento histórico de TuBot, intacto salvo por el refresh nuevo.
const AUTH_API_PATHS = ["/auth/login", "/auth/register", "/auth/mfa/", "/auth/accept-invite", "/auth/invite", "/auth/forgot", "/auth/reset", "/auth/passkey-login", "/auth/refresh", "/auth/logout"];
export function shouldRedirectOn401(path: string, pathname: string | null | undefined): boolean {
  if (AUTH_API_PATHS.some((p) => path.startsWith(p))) return false;
  if (pathname === "/login") return false;
  return true;
}

// Un solo refresh en vuelo: la carga de una pantalla dispara varias llamadas; si todas pegan 401
// a la vez, deben compartir UN refresh (el token rota en cada uso → refrescos paralelos se pisarían,
// y mostraría el Face ID varias veces).
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false; // sesión normal de TuBot (sin refresh): no hay nada que renovar
  // Pasado el plazo máximo, el servidor ya no renueva. Una sesión de aparato no tiene plazo.
  if (plazoVencido(getSessionDeadline())) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      let res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      let data = (await res.json()) as Partial<SesionDelServidor> & { needsAssertion?: boolean; loginId?: string; opciones?: unknown };
      // SESIÓN DE APARATO (passkeys P3): el servidor NO renueva sin una firma fresca del passkey.
      // Mostramos el Face ID / huella (es el prompt "una vez cada ~12 h" al morir el access) y
      // reintentamos con la aserción. Si la persona lo cancela, `startAuthentication` lanza → cae al
      // catch → re-login, que es lo correcto (sin la cara/dedo no se entra).
      if (data?.needsAssertion && data.loginId && data.opciones) {
        const assertion = await startAuthentication({ optionsJSON: data.opciones as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
        res = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: rt, loginId: data.loginId, assertion }),
        });
        if (!res.ok) return false;
        data = (await res.json()) as typeof data;
      }
      if (!data?.token) return false;
      setSession({ token: data.token, refreshToken: data.refreshToken, sessionExpiresAt: data.sessionExpiresAt });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(path: string, init: RequestInit = {}, _retried = false): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  // 401 en una llamada AUTENTICADA y fuera de las rutas de auth → sesión vencida. Bloque 3:
  // intentamos renovar UNA vez con el refresh token (sesión de aparato → Face ID) y reintentamos.
  // Bloque 1: si no se puede renovar, limpiamos y vamos al login. El 401 del login por contraseña
  // mala NO entra aquí (AUTH_API_PATHS) → jamás redirige en bucle.
  if (res.status === 401 && typeof window !== "undefined" && shouldRedirectOn401(path, window.location.pathname) && !_retried) {
    if (await tryRefresh()) return api<T>(path, init, true);
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

/**
 * Cerrar sesión: revoca el refresh token en el servidor (mata la sesión de aparato en Redis;
 * best-effort, no bloquea) y borra la sesión local. Una sesión normal sin refresh solo limpia local.
 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        keepalive: true,
      });
    } catch {
      /* el logout client-side sale igual aunque el servidor no responda */
    }
  }
  clearToken();
}
