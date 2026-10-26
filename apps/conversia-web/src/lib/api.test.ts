import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api.ts fija `const API = apiBase()` al importar → mockeamos api-base antes del import.
vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { api, jwtExp, sessionActive } from "./api";

/** JWT de juguete: header.payload.firma, payload = base64url({exp}). No se verifica la firma. */
function makeJwt(expSeconds: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
}
const res = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const TOKEN_KEY = "conversia_token";
const REFRESH_KEY = "conversia_refresh";

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

  it("401 del LOGIN por contraseña mala → jamás redirige (ni con token viejo presente)", async () => {
    store[TOKEN_KEY] = makeJwt(Math.floor(Date.now() / 1000) - 10); // token rancio en localStorage
    fetchMock.mockResolvedValueOnce(res(401, { message: "Credenciales inválidas" }));

    await expect(api("/auth/login", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });

    expect(replaceSpy).not.toHaveBeenCalled(); // sin bucle de redirección
    expect(store[TOKEN_KEY]).toBeDefined(); // no tocó la sesión
    expect(fetchMock).toHaveBeenCalledTimes(1); // no intentó refrescar
  });
});
