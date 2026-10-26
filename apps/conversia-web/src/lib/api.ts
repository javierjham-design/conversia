/** Cliente HTTP mínimo contra la MISMA API de la plataforma (un backend, dos frontends). */
import { apiBase } from "./api-base";
const API = apiBase();

const TOKEN_KEY = "conversia_token";
const REFRESH_KEY = "conversia_refresh";

// localStorage puede lanzar (modo privado, cookies bloqueadas) → todo acceso va envuelto.
function lsGet(k: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* modo privado: la sesión vivirá solo en memoria de esta pestaña */
  }
}
function lsDel(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}

export function getToken(): string | null {
  return lsGet(TOKEN_KEY);
}
export function setToken(t: string): void {
  lsSet(TOKEN_KEY, t);
}
export function getRefreshToken(): string | null {
  return lsGet(REFRESH_KEY);
}
/** Guarda la sesión completa (access + refresh). El refresh es opcional (TuBot no lo emite/usa). */
export function setSession(s: { token: string; refreshToken?: string | null }): void {
  lsSet(TOKEN_KEY, s.token);
  if (s.refreshToken) lsSet(REFRESH_KEY, s.refreshToken);
}
/** Cerrar sesión = borrar AMBOS tokens (access y refresh). */
export function clearToken(): void {
  lsDel(TOKEN_KEY);
  lsDel(REFRESH_KEY);
}

// ───────────────────────────── Sesión / expiración ─────────────────────────────

/** Lee el claim `exp` (segundos UNIX) del JWT sin verificar la firma. null si no es un JWT legible. */
export function jwtExp(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8");
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * ¿El access token es una sesión AÚN vigente? true solo si trae `exp` y está en el futuro.
 * Un token ausente, ilegible o vencido → false. Se usa client-side (landing/AppShell) para no
 * meter al usuario a un panel con sesión muerta, SIN una llamada de red.
 */
export function sessionActive(token: string | null, nowMs: number = Date.now()): boolean {
  const exp = jwtExp(token);
  return exp !== null && exp * 1000 > nowMs;
}

// Páginas públicas: un 401 estando en ellas NO debe redirigir (evita bucles).
const PUBLIC_PAGES = ["/login", "/crear", "/registro", "/legal", "/n/"];
function onPublicPage(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

/** Rutas de la API cuyo 401 NO dispara el flujo de sesión expirada (lo maneja quien llama). */
const AUTH_PATHS = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout"];
function isAuthPath(path: string): boolean {
  return AUTH_PATHS.some((p) => path.startsWith(p));
}

/** Limpia la sesión y manda al login con el motivo + la ruta a la que volver tras re-entrar. */
export function handleSessionExpired(): void {
  clearToken();
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (onPublicPage(pathname)) return; // ya está en una pública (incluido /login) → no redirigir
  const volver = encodeURIComponent(pathname + search);
  window.location.replace(`/login?expirada=1&volver=${volver}`);
}

// Un solo refresh en vuelo: la carga de una pantalla dispara varias llamadas; si todas pegan 401
// a la vez, deben compartir UN refresh (el token rota en cada uso → refrescos paralelos se pisarían).
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { token?: string; refreshToken?: string };
      if (!data?.token) return false;
      setSession({ token: data.token, refreshToken: data.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(path: string, init?: RequestInit, _retried = false): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // 401 en una llamada AUTENTICADA (había token) y fuera de las rutas de auth → sesión vencida.
  // Bloque 3: intentamos renovar UNA vez con el refresh token y reintentamos. Bloque 1: si no se
  // puede renovar, limpiamos y vamos a /login?expirada=1&volver=<ruta>. El 401 del login por
  // contraseña mala NO entra aquí (isAuthPath) → jamás redirige en bucle.
  if (res.status === 401 && token && !isAuthPath(path) && !_retried) {
    if (await tryRefresh()) return api<T>(path, init, true);
    handleSessionExpired();
  }

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

/**
 * Cerrar sesión (Bloque 2): revoca el refresh token en el servidor (best-effort; no bloquea) y
 * borra la sesión local. Devuelve el control al caller para redirigir a /login.
 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    await fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      keepalive: true,
    });
  } catch {
    /* el logout client-side sale igual aunque el servidor no responda */
  }
  clearToken();
}
