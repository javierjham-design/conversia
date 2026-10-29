import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DB_ROLE_RECHECK_MS,
  checkTenantDbRole,
  ensureTenantDbRoleChecked,
  roleBypassesRls,
  shouldRecheckDbRole,
} from "@conversia/database";

/**
 * AJUSTE FINAL §2.0 — el chequeo de rol de BD (¿el rol de DATABASE_URL puede saltarse la
 * RLS?) tiene que funcionar en PRODUCCIÓN. Antes corría una sola vez al arrancar y su catch
 * se tragaba el error → en prod quedaba "sin verificar" para siempre y nadie sabía por qué.
 * Ahora: el error se REGISTRA (sin credenciales) y /health/status REINTENTA (tope 1/min).
 *
 * Nota: `checkTenantDbRole`/`ensureTenantDbRoleChecked` mantienen estado de módulo; los tests
 * de abajo están ORDENADOS para que el único que fija el estado a "verificado" sea el último.
 */

/** Cliente Prisma falso: $queryRaw devuelve (o lanza) lo que se le indique. */
function fakeClient(result: unknown[] | Error) {
  const calls = { n: 0 };
  return {
    calls,
    $queryRaw: vi.fn(async () => {
      calls.n++;
      if (result instanceof Error) throw result;
      return result;
    }),
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("roleBypassesRls — la regla pura", () => {
  it("sin fila = no se pudo determinar (null)", () => {
    expect(roleBypassesRls(undefined)).toBeNull();
    expect(roleBypassesRls(null)).toBeNull();
  });
  it("rolsuper o rolbypassrls = puede saltarse la RLS", () => {
    expect(roleBypassesRls({ rolsuper: true, rolbypassrls: false })).toBe(true);
    expect(roleBypassesRls({ rolsuper: false, rolbypassrls: true })).toBe(true);
  });
  it("rol restringido = NO se la salta", () => {
    expect(roleBypassesRls({ rolsuper: false, rolbypassrls: false })).toBe(false);
  });
});

describe("shouldRecheckDbRole — cuándo reintentar", () => {
  const sinVerificar = { ok: null };
  it("fuera de producción: nunca", () => {
    expect(shouldRecheckDbRole(sinVerificar, false, 10 * DB_ROLE_RECHECK_MS, 0)).toBe(false);
  });
  it("ya verificado (true o false): nunca", () => {
    expect(shouldRecheckDbRole({ ok: true }, true, 10 * DB_ROLE_RECHECK_MS, 0)).toBe(false);
    expect(shouldRecheckDbRole({ ok: false }, true, 10 * DB_ROLE_RECHECK_MS, 0)).toBe(false);
  });
  it("sin verificar en prod y pasó el tope: sí", () => {
    expect(shouldRecheckDbRole(sinVerificar, true, DB_ROLE_RECHECK_MS, 0)).toBe(true);
  });
  it("sin verificar en prod pero DENTRO del tope: no (una pasada por minuto)", () => {
    expect(shouldRecheckDbRole(sinVerificar, true, DB_ROLE_RECHECK_MS - 1, 0)).toBe(false);
  });
});

describe("checkTenantDbRole — registra el error, no lo traga", () => {
  it("si la consulta a pg_roles LANZA, lo registra (sin el URL) y NO revienta", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      checkTenantDbRole(fakeClient(new Error("connect ECONNREFUSED 10.0.0.9:5432"))),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    const msg = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(msg).toContain("No se pudo verificar el rol de BD");
    expect(msg).not.toContain("DATABASE_URL"); // jamás el URL con credenciales
  });
});

describe("ensureTenantDbRoleChecked — reintento acotado desde /health", () => {
  it("fuera de producción no consulta y queda sin verificar", async () => {
    const client = fakeClient([{ rolsuper: false, rolbypassrls: false }]);
    const st = await ensureTenantDbRoleChecked(false, { client, now: 10 * DB_ROLE_RECHECK_MS });
    expect(client.calls.n).toBe(0);
    expect(st).toEqual({ checked: false, ok: null });
  });

  it("en prod, sin verificar: consulta, resuelve a 'rol restringido' y no re-consulta dentro del minuto", async () => {
    const client = fakeClient([{ rolsuper: false, rolbypassrls: false }]);
    const t0 = 10 * DB_ROLE_RECHECK_MS;
    const st1 = await ensureTenantDbRoleChecked(true, { client, now: t0 });
    expect(client.calls.n).toBe(1);
    expect(st1).toEqual({ checked: true, ok: true });
    // Ya verificado → aunque pase mucho tiempo, no vuelve a consultar (status.ok !== null).
    const st2 = await ensureTenantDbRoleChecked(true, { client, now: t0 + 10 * DB_ROLE_RECHECK_MS });
    expect(client.calls.n).toBe(1);
    expect(st2).toEqual({ checked: true, ok: true });
  });
});
