/** Cliente HTTP mínimo contra la MISMA API de la plataforma (un backend, dos frontends). */
import { apiBase } from "./api-base";
const API = apiBase();

const TOKEN_KEY = "conversia_token";
const REFRESH_KEY = "conversia_refresh";
/** Plazo MÁXIMO de la sesión (ms epoch). Lo manda el servidor; acá solo se refleja. */
const PLAZO_KEY = "conversia_session_until";

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
/**
 * Reemplaza SOLO el access token, de una sesión cuyo plazo no conocemos: el borrador de
 * `/crear` y el token de soporte (impersonación, 30 min). Por eso borra el plazo guardado —
 * si quedara el de la sesión anterior, esa pestaña se creería vencida de entrada.
 */
export function setToken(t: string): void {
  lsSet(TOKEN_KEY, t);
  lsDel(PLAZO_KEY);
}
export function getRefreshToken(): string | null {
  return lsGet(REFRESH_KEY);
}

/** Lo que devuelve la API al abrir o renovar una sesión. */
export interface SesionDelServidor {
  token: string;
  refreshToken?: string | null;
  /** Techo absoluto de la sesión en ISO (24 h desde el login). Ausente = no lo sabemos. */
  sessionExpiresAt?: string | null;
}

/** Guarda la sesión completa (access + refresh + plazo). El refresh es opcional (TuBot no lo usa). */
export function setSession(s: SesionDelServidor): void {
  lsSet(TOKEN_KEY, s.token);
  if (s.refreshToken) lsSet(REFRESH_KEY, s.refreshToken);
  const plazo = s.sessionExpiresAt ? Date.parse(s.sessionExpiresAt) : NaN;
  if (Number.isFinite(plazo)) lsSet(PLAZO_KEY, String(plazo));
  else lsDel(PLAZO_KEY);
}
/** Cerrar sesión = borrar los TRES datos (access, refresh y plazo). */
export function clearToken(): void {
  lsDel(TOKEN_KEY);
  lsDel(REFRESH_KEY);
  lsDel(PLAZO_KEY);
}

/**
 * Plazo máximo de la sesión en ms epoch, o null si no lo sabemos (sesión guardada antes de
 * que esto existiera, o api anterior al cambio: conversia-web se despliega sola al mergear,
 * así que puede ir por delante de la api). Un valor ilegible se trata como ausente.
 */
export function getSessionDeadline(): number | null {
  const raw = lsGet(PLAZO_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * ¿Se pasó el plazo? Solo true con un plazo CONOCIDO y ya vencido: no saber nunca puede
 * significar "vencida", o sacaríamos al login a gente con sesión válida. Quien manda es el
 * servidor (el techo va firmado en el token, claim `sxp`); esto evita el viaje perdido y el
 * parpadeo de panel.
 */
export function plazoVencido(plazo: number | null, nowMs: number = Date.now()): boolean {
  return plazo !== null && plazo <= nowMs;
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
// §10.5 — `/recuperar` es pública: quien la abre no tiene sesión (viene del enlace del
// correo). Sin esto, el flujo de "sesión expirada" la sacaría al login a mitad de camino.
const PUBLIC_PAGES = ["/login", "/crear", "/registro", "/legal", "/recuperar", "/n/"];
function onPublicPage(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

/** Rutas de la API cuyo 401 NO dispara el flujo de sesión expirada (lo maneja quien llama). */
// §10.5 — `forgot`/`reset` van acá: quien las usa no tiene sesión, así que un 401 (o el
// 400 del enlace vencido) lo muestra la propia pantalla, no el flujo de "sesión expirada".
const AUTH_PATHS = ["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout", "/auth/forgot", "/auth/reset"];
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
  // Pasado el plazo máximo, el servidor ya no renueva (el techo viaja en la sesión de Redis):
  // pedirlo igual es un viaje perdido y, en la landing, un parpadeo de panel antes de la patada.
  if (plazoVencido(getSessionDeadline())) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as Partial<SesionDelServidor>;
      if (!data?.token) return false;
      // El plazo se vuelve a guardar en cada renovación: el servidor manda SIEMPRE el mismo
      // (el del login), porque renovar corre la ventana deslizante pero nunca el techo.
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
