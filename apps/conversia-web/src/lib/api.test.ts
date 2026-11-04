import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api.ts fija `const API = apiBase()` al importar → mockeamos api-base antes del import.
vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { api, clearToken, getSessionDeadline, jwtExp, plazoVencido, sessionActive, setSession } from "./api";

/** JWT de juguete: header.payload.firma, payload = base64url({exp}). No se verifica la firma. */
function makeJwt(expSeconds: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
}
const res = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const TOKEN_KEY = "conversia_token";
const REFRESH_KEY = "conversia_refresh";
const PLAZO_KEY = "conversia_session_until";

let store: Record<string, string>;
let replaceSpy: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = {};
  const ls = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  replaceSpy = vi.fn();
  fetchMock = vi.fn();
  (globalThis as any).window = { location: { pathname: "/clientes", search: "?x=1", replace: replaceSpy } };
  (globalThis as any).localStorage = ls;
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).fetch;
});

describe("jwtExp / sessionActive (puras, sin red)", () => {
  it("lee exp y distingue sesión viva de vencida", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(jwtExp(makeJwt(future))).toBe(future);
    expect(sessionActive(makeJwt(future))).toBe(true);
    expect(sessionActive(makeJwt(past))).toBe(false);
  });
  it("token ausente o ilegible → no es sesión viva", () => {
    expect(jwtExp(null)).toBeNull();
    expect(jwtExp("no-es-un-jwt")).toBeNull();
    expect(sessionActive(null)).toBe(false);
    expect(sessionActive("basura")).toBe(false);
  });
});

describe("plazo máximo de la sesión (24 h)", () => {
  it("setSession guarda el plazo que manda el servidor y clearToken lo borra", () => {
    const plazo = new Date(Date.now() + 86_400_000).toISOString();
    setSession({ token: "t", refreshToken: "rt_x", sessionExpiresAt: plazo });
    expect(store[PLAZO_KEY]).toBe(String(Date.parse(plazo)));
    expect(getSessionDeadline()).toBe(Date.parse(plazo));

    clearToken();
    expect(store[PLAZO_KEY]).toBeUndefined();
    expect(getSessionDeadline()).toBeNull();
  });

  it("un login sin plazo (TuBot, o una api vieja) no deja plazo guardado", () => {
    setSession({ token: "t" });
    expect(store[PLAZO_KEY]).toBeUndefined();
    expect(getSessionDeadline()).toBeNull();
  });

  it("un plazo ilegible se trata como ausente, nunca como vencido", () => {
    store[PLAZO_KEY] = "mañana";
    expect(getSessionDeadline()).toBeNull();
    expect(plazoVencido(null)).toBe(false);
  });

  it("plazoVencido solo es true con un plazo conocido y pasado", () => {
    expect(plazoVencido(Date.now() - 1)).toBe(true);
    expect(plazoVencido(Date.now() + 60_000)).toBe(false);
    expect(plazoVencido(null)).toBe(false);
  });
});

describe("api() — manejo de sesión vencida (Bloque 1 + 3)", () => {
  it("401 con token y SIN refresh → limpia sesión y redirige a /login?expirada con volver", async () => {
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10);
    fetchMock.mockResolvedValueOnce(res(401, { message: "Token inválido o expirado" }));

    await expect(api("/clientes")).rejects.toMatchObject({ status: 401 });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy.mock.calls[0][0]).toBe(`/login?expirada=1&volver=${encodeURIComponent("/clientes?x=1")}`);
    expect(store[TOKEN_KEY]).toBeUndefined(); // sesión limpiada
    expect(fetchMock).toHaveBeenCalledTimes(1); // no hubo intento de refresh (no había)
  });

  it("401 con refresh válido → renueva UNA vez, reintenta y devuelve el dato (sin redirigir)", async () => {
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10);
    store[REFRESH_KEY] = "rt_viejo";
    const nuevo = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    fetchMock
      .mockResolvedValueOnce(res(401)) // llamada original
      .mockResolvedValueOnce(res(200, { token: nuevo, refreshToken: "rt_nuevo" })) // /auth/refresh
      .mockResolvedValueOnce(res(200, { data: "ok" })); // reintento

    const out = await api<{ data: string }>("/clientes");

    expect(out).toEqual({ data: "ok" });
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe("http://api.test/auth/refresh");
    expect(store[TOKEN_KEY]).toBe(nuevo); // rotó el access
    expect(store[REFRESH_KEY]).toBe("rt_nuevo"); // rotó el refresh
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("el refresh guarda el plazo máximo que manda el servidor (no lo corre)", async () => {
    // Renovar corre la ventana deslizante pero NO el techo: el servidor manda el mismo
    // `sessionExpiresAt` del login en cada renovación, y el cliente lo refleja tal cual.
    const plazo = new Date(Date.now() + 6 * 3_600_000).toISOString();
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10);
    store[REFRESH_KEY] = "rt_viejo";
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200, { token: makeJwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: "rt_nuevo", sessionExpiresAt: plazo }))
      .mockResolvedValueOnce(res(200, { data: "ok" }));

    await api("/clientes");

    expect(store[PLAZO_KEY]).toBe(String(Date.parse(plazo)));
  });

  it("401 y el refresh TAMBIÉN falla → limpia y redirige (no reintenta en bucle)", async () => {
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10);
    store[REFRESH_KEY] = "rt_muerto";
    fetchMock
      .mockResolvedValueOnce(res(401)) // original
      .mockResolvedValueOnce(res(401)); // refresh también 401

    await expect(api("/clientes")).rejects.toMatchObject({ status: 401 });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(store[TOKEN_KEY]).toBeUndefined();
    expect(store[REFRESH_KEY]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + 1 refresh, sin más
  });

  it("con el plazo de 24 h ya vencido NO intenta refrescar: al login y listo", async () => {
    // Pedirle un refresh a una sesión que el servidor ya mató es un viaje perdido (y en la
    // landing, un parpadeo de panel antes de la patada). El plazo lo manda el servidor.
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10);
    store[REFRESH_KEY] = "rt_fuera_de_plazo";
    store[PLAZO_KEY] = String(Date.now() - 1000);
    fetchMock.mockResolvedValueOnce(res(401));

    await expect(api("/clientes")).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no se llamó a /auth/refresh
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(store[PLAZO_KEY]).toBeUndefined(); // se limpió con el resto de la sesión
  });

  it("401 del LOGIN por contraseña mala → jamás redirige (ni con token viejo presente)", async () => {
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10); // token rancio en localStorage
    fetchMock.mockResolvedValueOnce(res(401, { message: "Credenciales inválidas" }));

    await expect(api("/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });

    expect(replaceSpy).not.toHaveBeenCalled(); // sin bucle de redirección
    expect(store[TOKEN_KEY]).toBeDefined(); // no tocó la sesión
    expect(fetchMock).toHaveBeenCalledTimes(1); // no intentó refrescar
  });
});
