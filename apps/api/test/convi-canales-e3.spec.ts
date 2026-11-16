import { describe, it, expect, vi } from "vitest";
import { AssistantService } from "../src/assistant/assistant.service";
import { runSetupTool, setupToolSpecs, type SetupToolCtx } from "../src/assistant/setup-tools";
import { explicarCamino } from "../src/assistant/setup-logic";
import type { PrismaService } from "../src/prisma.service";

/**
 * E3.a — CANALES Y ASISTENTE: Convi cumple lo que venía prometiendo.
 *
 * `explicarCamino("asignar_agente")` le dice al dueño «Lo asigno y queda andando» desde que
 * existe, y Convi no tenía con qué hacerlo: había que mandarlo a la pantalla. Prometer y no
 * poder es lo peor de los dos mundos.
 */

const prismaFalso = {} as PrismaService;
const ctx = (canales?: SetupToolCtx["canales"]): SetupToolCtx => ({ organizationId: "org1", userId: "u1", canales });

describe("la promesa que había que cumplir", () => {
  it("el texto sigue prometiendo que lo asigna", () => {
    expect(explicarCamino("asignar_agente")).toMatch(/lo asigno/i);
  });

  it("y ahora existe la herramienta que lo hace", () => {
    expect(setupToolSpecs().write.some((s) => s.name === "asignarAsistenteACanal")).toBe(true);
  });
});

describe("asignarAsistenteACanal", () => {
  it("llama al MISMO endpoint del panel con el id del asistente", async () => {
    const update = vi.fn(async () => ({ ok: true }));
    const canales = { update, test: vi.fn(), list: vi.fn(async () => [{ id: "ch1", status: "active" }]) } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "asignarAsistenteACanal", { asistenteId: "ag1" });
    expect(update).toHaveBeenCalledWith("ch1", { defaultAgentId: "ag1" });
    expect(r!.didWrite).toBe(true);
  });

  it("refresca el checklist: asignar el asistente MUEVE el avance del montaje", async () => {
    const canales = { update: vi.fn(async () => ({})), test: vi.fn(), list: vi.fn(async () => [{ id: "ch1" }]) } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "asignarAsistenteACanal", { asistenteId: "ag1" });
    expect(r!.actions?.some((a) => a.type === "checklist_refresh")).toBe(true);
  });

  it("con VARIOS canales no adivina: pide que le digan cuál", async () => {
    const canales = {
      update: vi.fn(),
      test: vi.fn(),
      list: vi.fn(async () => [{ id: "ch1", status: "active" }, { id: "ch2", status: "active" }]),
    } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "asignarAsistenteACanal", { asistenteId: "ag1" });
    expect(r!.isError).toBe(true);
    expect(r!.content).toMatch(/dime cual|dime cuál/i);
  });

  it("los canales inactivos no cuentan para decidir si hay uno solo", async () => {
    const update = vi.fn(async () => ({}));
    const canales = {
      update,
      test: vi.fn(),
      list: vi.fn(async () => [{ id: "ch1", status: "active" }, { id: "viejo", status: "inactive" }]),
    } as never;
    await runSetupTool(prismaFalso, ctx(canales), "asignarAsistenteACanal", { asistenteId: "ag1" });
    expect(update).toHaveBeenCalledWith("ch1", { defaultAgentId: "ag1" });
  });

  it("sin asistente indicado, no hace nada", async () => {
    const r = await runSetupTool(prismaFalso, ctx({} as never), "asignarAsistenteACanal", {});
    expect(r!.isError).toBe(true);
  });

  it("si el endpoint rechaza, el motivo llega al dueño", async () => {
    const canales = {
      update: vi.fn(async () => { throw new Error("Canal no encontrado o inactivo"); }),
      test: vi.fn(),
      list: vi.fn(async () => [{ id: "ch1" }]),
    } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "asignarAsistenteACanal", { asistenteId: "ag1" });
    expect(r!.isError).toBe(true);
    expect(r!.content).toContain("Canal no encontrado");
  });
});

describe("probarCanal", () => {
  it("devuelve lo que diga Meta", async () => {
    const canales = { update: vi.fn(), test: vi.fn(async () => ({ ok: true, detail: "+56 9 1111 1111" })), list: vi.fn(async () => [{ id: "ch1" }]) } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "probarCanal", {});
    expect(JSON.parse(r!.content).ok).toBe(true);
  });

  it("una prueba FALLIDA no es un error de la herramienta: es información", async () => {
    // Si se marcara `isError`, el modelo lo trataría como "no se pudo consultar" en vez de
    // "el canal está mal", que es justo lo que el dueño necesita saber.
    const canales = {
      update: vi.fn(),
      test: vi.fn(async () => { throw new Error("El token del canal no es válido"); }),
      list: vi.fn(async () => [{ id: "ch1" }]),
    } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "probarCanal", {});
    expect(r!.isError).toBeFalsy();
    expect(JSON.parse(r!.content)).toMatchObject({ ok: false });
    expect(JSON.parse(r!.content).detalle).toContain("token");
  });
});

describe("pausarOReanudarBot", () => {
  it("pausar deja el canal sin asistente por defecto", async () => {
    const update = vi.fn(async () => ({}));
    const canales = { update, test: vi.fn(), list: vi.fn(async () => [{ id: "ch1" }]) } as never;
    const r = await runSetupTool(prismaFalso, ctx(canales), "pausarOReanudarBot", { pausar: true });
    expect(update).toHaveBeenCalledWith("ch1", { defaultAgentId: null });
    expect(r!.content).toMatch(/siguen llegando a la Bandeja/i);
  });

  it("reanudar NO borra la asignación: manda `undefined`, que el endpoint ignora", async () => {
    const update = vi.fn(async () => ({}));
    const canales = { update, test: vi.fn(), list: vi.fn(async () => [{ id: "ch1" }]) } as never;
    await runSetupTool(prismaFalso, ctx(canales), "pausarOReanudarBot", { pausar: false });
    expect(update).toHaveBeenCalledWith("ch1", { defaultAgentId: undefined });
  });
});

describe("sin el controlador de canales, Convi lo dice y no revienta", () => {
  it("cada herramienta degrada con un mensaje, no con una excepción", async () => {
    for (const t of ["asignarAsistenteACanal", "probarCanal", "pausarOReanudarBot"]) {
      const r = await runSetupTool(prismaFalso, ctx(undefined), t, { asistenteId: "a", pausar: true });
      expect(r!.isError).toBe(true);
      expect(r!.content).toMatch(/ahora mismo/i);
    }
  });
});

describe("el prompt lo manda ACTUAR, no explicar", () => {
  const svc = new AssistantService({} as never, {} as never);
  const prompt = (svc as unknown as { systemPrompt(c: unknown, o: boolean, r?: string): string }).systemPrompt(
    (svc as unknown as { minimalContext(): unknown }).minimalContext(),
    true,
    "/canales",
  );

  it("ante un canal sin asistente, asigna en vez de explicar cómo", () => {
    expect(prompt).toContain("asignarAsistenteACanal");
    expect(prompt).toMatch(/no expliques como asignarlo/i);
  });

  it("ante «no contesta», prueba el canal antes de culpar al asistente", () => {
    expect(prompt).toContain("probarCanal");
    expect(prompt).toMatch(/antes de culpar al asistente/i);
  });

  it("conectar sigue siendo un botón del dueño", () => {
    expect(prompt).toMatch(/sigue siendo un boton del dueno/i);
  });

  it("no describe el prompt del asistente de memoria", () => {
    expect(prompt).toContain("verPromptDelAsistente");
    expect(prompt).toMatch(/Nunca describas de memoria/i);
  });
});
