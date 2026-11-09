import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * LA ALARMA DE CONVI.
 *
 * Convi estuvo SIETE DÍAS contestando "estoy teniendo un problema para responder" a todo el
 * mundo (2 al 9-nov-2026) y `/health/status` dijo `ok:true` todo ese tiempo. Lo encontró el
 * dueño mirando la pantalla. El chequeo `ai` que ya existía mira otra cosa: la degradación
 * del router que marca el WORKER, o sea los bots de WhatsApp.
 */

const fila: { value: string | null } = { value: null };

const prisma = {
  platformSetting: {
    findUnique: vi.fn(async () => (fila.value === null ? null : { key: "assistant:caido", value: fila.value })),
    upsert: vi.fn(async ({ update }: { update: { value: string } }) => {
      fila.value = update.value;
      return { value: fila.value };
    }),
    deleteMany: vi.fn(async () => {
      fila.value = null;
      return { count: 1 };
    }),
  },
};

vi.mock("@conversia/database", () => ({ getAdminPrisma: () => prisma }));

import {
  CONVI_CAIDO_VENTANA_MS,
  detalleConviCaido,
  leerConviCaido,
  limpiarConviCaido,
  marcarConviCaido,
} from "../src/assistant/convi-salud";

describe("alarma de Convi", () => {
  beforeEach(() => {
    fila.value = null;
    vi.useRealTimers();
  });

  it("al fallarle el proveedor queda la marca, con proveedor, modelo y motivo", async () => {
    await marcarConviCaido("openai", "gpt-4o-mini", "400 Invalid 'tools[10].function.name'");
    const info = await leerConviCaido();
    expect(info?.proveedor).toBe("openai");
    expect(info?.modelo).toBe("gpt-4o-mini");
    expect(info?.error).toContain("tools[10]");
  });

  it("el primer turno bueno la apaga", async () => {
    await marcarConviCaido("openai", "gpt-4o-mini", "400");
    expect(await leerConviCaido()).not.toBeNull();
    await limpiarConviCaido();
    expect(await leerConviCaido()).toBeNull();
  });

  it("`desde` NO se reinicia en cada fallo: el aviso dice cuánto lleva roto", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T20:40:00Z"));
    await marcarConviCaido("openai", "gpt-4o-mini", "400");
    const primero = (await leerConviCaido())!.desde;
    vi.setSystemTime(new Date("2026-11-02T22:40:00Z"));
    await marcarConviCaido("openai", "gpt-4o-mini", "400 otra vez");
    const info = (await leerConviCaido())!;
    expect(info.desde).toBe(primero);
    expect(detalleConviCaido(info)).toContain("2 h");
  });

  it("una marca vieja deja de creerse: un incidente de hace días no es una caída de hoy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T20:40:00Z"));
    await marcarConviCaido("openai", "gpt-4o-mini", "400");
    vi.setSystemTime(new Date("2026-11-02T20:40:00Z").getTime() + CONVI_CAIDO_VENTANA_MS + 1000);
    expect(await leerConviCaido()).toBeNull();
  });

  it("si la base de datos no responde, el turno del cliente NO se cae por la telemetría", async () => {
    prisma.platformSetting.upsert.mockRejectedValueOnce(new Error("db caída"));
    await expect(marcarConviCaido("openai", "gpt-4o-mini", "400")).resolves.toBeUndefined();
  });

  it("el detalle dice desde cuándo y con qué proveedor/modelo", () => {
    const desde = Date.parse("2026-11-02T20:37:00Z");
    const txt = detalleConviCaido({ desde, proveedor: "openai", modelo: "gpt-4o-mini", error: "400 Invalid" }, desde + 45 * 60000);
    expect(txt).toContain("45 min");
    expect(txt).toContain("openai/gpt-4o-mini");
    expect(txt).toContain("400 Invalid");
  });
});

describe("el cableado al endpoint de salud", () => {
  it("el chequeo de Convi se agrega ANTES del agregado, para que tumbe el `ok`", () => {
    // Si se añadiera después, saldría en el detalle y NO pondría `ok:false`: una alarma que
    // se publica y no suena. Es exactamente el error que tuvo este mismo cambio al escribirlo.
    const src = readFileSync(join(__dirname, "..", "src", "health.controller.ts"), "utf8");
    const asignacion = src.indexOf("checks.convi =");
    const agregado = src.indexOf("const ok = Object.values(checks)");
    expect(asignacion, "no se encontró el chequeo de Convi").toBeGreaterThan(-1);
    expect(agregado, "no se encontró el agregado").toBeGreaterThan(-1);
    expect(asignacion, "checks.convi quedó DESPUÉS del agregado: no tumbaría el ok").toBeLessThan(agregado);
  });

  it("el copiloto marca la caída donde el endpoint la lee", () => {
    const svc = readFileSync(join(__dirname, "..", "src", "assistant", "assistant.service.ts"), "utf8");
    expect(svc).toMatch(/await marcarConviCaido\(cfg\.provider, model,/);
    expect(svc).toMatch(/if \(!degradado\) await limpiarConviCaido\(\);/);
  });
});
