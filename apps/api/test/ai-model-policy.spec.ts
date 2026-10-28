import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 1 — el modelo de IA lo elige la PLATAFORMA, no el cliente (§4).
 *
 * Con Créditos IA el modelo multiplica el consumo: la misma respuesta cuesta 1 crédito
 * con gpt-4o-mini y 50 con claude-opus. Si el cliente pudiera cambiarlo, se quedaría sin
 * saldo en una tarde sin entender por qué. Esconder el selector en el panel no alcanza:
 * `PUT /agents/:id/draft` recibe el `config` completo, así que la guarda es de servidor.
 */

const state = {
  brand: "conversia" as string,
  policyRow: null as null | { value: string },
  fallarBase: false,
};

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    organization: {
      findUnique: async () => {
        if (state.fallarBase) throw new Error("BD caída");
        return { brand: state.brand };
      },
    },
    platformSetting: { findUnique: async () => state.policyRow },
  }),
}));

import { applyModelLock, defaultAgentModel, modelChangeImpact, resetAiModelPolicyCache } from "../src/agents/model-policy";

beforeEach(() => {
  state.brand = "conversia";
  state.policyRow = null;
  state.fallarBase = false;
  resetAiModelPolicyCache();
});

describe("§4 — candado de modelo en los endpoints de tenant", () => {
  it("un cliente de Conversia NO puede cambiar el modelo: se conserva el que tenía", async () => {
    const r = await applyModelLock({
      organizationId: "o",
      incoming: { model: "claude-opus-4-8", maxTokens: 400 },
      current: { model: "gpt-4o-mini" },
    });
    expect(r.config.model).toBe("gpt-4o-mini");
    expect(r.overridden).toBe(true);
    expect(r.requested).toBe("claude-opus-4-8");
  });

  it("guardar el prompt sin tocar el modelo NO se marca como intento (el panel manda todo el config)", async () => {
    // Si esto contara como intento, cada guardado del editor dejaría un registro de
    // auditoría falso y el cliente parecería estar atacándonos.
    const r = await applyModelLock({
      organizationId: "o",
      incoming: { model: "gpt-4o-mini", maxTokens: 800 },
      current: { model: "gpt-4o-mini" },
    });
    expect(r.overridden).toBe(false);
    expect(r.config.maxTokens).toBe(800); // lo demás del config sí se guarda
  });

  it("un agente que ya tiene un modelo avanzado (activado por el super admin) lo CONSERVA", async () => {
    // El cliente no puede subirlo, pero tampoco puede bajárselo por accidente al guardar.
    const r = await applyModelLock({
      organizationId: "o",
      incoming: { model: "gpt-4o-mini" },
      current: { model: "gpt-4o" },
    });
    expect(r.config.model).toBe("gpt-4o");
    expect(r.overridden).toBe(true);
  });

  it("un agente nuevo (sin versión previa) nace con el modelo estándar", async () => {
    const r = await applyModelLock({ organizationId: "o", incoming: { model: "claude-sonnet-4-6" }, current: null });
    expect(r.config.model).toBe("gpt-4o-mini");
  });

  it("TuBot no cambia: ahí el modelo se sigue pudiendo mandar como siempre", async () => {
    state.brand = "tubot";
    const r = await applyModelLock({
      organizationId: "o",
      incoming: { model: "claude-opus-4-8" },
      current: { model: "gpt-4o-mini" },
    });
    expect(r.config.model).toBe("claude-opus-4-8");
    expect(r.overridden).toBe(false);
  });

  it("si no se puede leer la marca, NO bloquea (nadie se queda sin poder guardar su bot)", async () => {
    state.fallarBase = true;
    const r = await applyModelLock({ organizationId: "o", incoming: { model: "gpt-4o" }, current: { model: "gpt-4o-mini" } });
    expect(r.config.model).toBe("gpt-4o");
  });
});

describe("§4 — el modelo estándar sale de configuración", () => {
  it("por defecto, gpt-4o-mini", async () => {
    expect(await defaultAgentModel()).toBe("gpt-4o-mini");
  });

  it("el equipo puede cambiar el estándar sin desplegar", async () => {
    state.policyRow = { value: JSON.stringify({ defaultModel: "claude-haiku-4-5" }) };
    expect(await defaultAgentModel()).toBe("claude-haiku-4-5");
    const r = await applyModelLock({ organizationId: "o", incoming: {}, current: null });
    expect(r.config.model).toBe("claude-haiku-4-5");
  });

  it("una fila corrupta no deja a los bots sin modelo", async () => {
    state.policyRow = { value: "{{{" };
    expect(await defaultAgentModel()).toBe("gpt-4o-mini");
  });
});

describe("§4 — impacto que se le muestra al cliente antes de aceptar", () => {
  it("traduce el cambio a conversaciones, que es lo que el cliente entiende", async () => {
    // El ejemplo del documento: 1.000 créditos rinden ~240 conversaciones con el estándar
    // y ~60 con el Plus (peso 4).
    const i = modelChangeImpact({ from: "gpt-4o-mini", to: "claude-haiku-4-5", remainingCredits: 1_000 });
    expect(i.from.conversations).toBe(238);
    expect(i.to.conversations).toBe(59);
    expect(i.to.creditsPerReply).toBe(4);
    expect(i.cheaper).toBe(false);
  });

  it("volver al estándar es más barato y no necesita aceptación", async () => {
    const i = modelChangeImpact({ from: "gpt-4o", to: "gpt-4o-mini", remainingCredits: 1_000 });
    expect(i.cheaper).toBe(true);
  });

  it("con saldo 0 no divide por cero ni muestra números raros", async () => {
    const i = modelChangeImpact({ from: "gpt-4o-mini", to: "gpt-4o", remainingCredits: 0 });
    expect(i.to.conversations).toBe(0);
  });
});
