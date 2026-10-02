/**
 * Cliente del SUPER ADMIN de Conversia. Habla con la MISMA API de plataforma que el
 * super admin de TuBot, pero desde el Origin de Conversia (app.conversia.cl): el backend
 * deriva la marca del Origin (D8) y el token de plataforma lleva `brand=conversia`, así
 * este panel solo ve y opera los tenants de Conversia. Token SEPARADO del de tenant.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "conversia_platform_token";

export function getPlatformToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setPlatformToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearPlatformToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Error con el status HTTP y el cuerpo, para que la UI distinga MFA / 401 / validación. */
export class PlatformApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super((body?.message as string) ?? `Error ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function padmin<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Sesión caída/expirada (no en el flujo de login) → al login del super admin.
    if (res.status === 401 && typeof window !== "undefined" && !path.includes("/platform/auth/")) {
      clearPlatformToken();
      if (!location.pathname.startsWith("/admin/login")) location.replace("/admin/login");
    }
    throw new PlatformApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}
