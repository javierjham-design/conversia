import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * UNA SOLA configuración de inicio de sesión de Meta por marca, para los DOS caminos.
 *
 * El caso (11-nov-2026): conectar el WhatsApp que el cliente ya usa terminaba en la pantalla
 * de **configuración de Meta** en vez de en «Finalizar». La marca conversia era la ÚNICA con
 * dos `config_id` —una para número nuevo y otra para coexistencia—; TuBot, que funciona en
 * producción, siempre usó una sola. Meta confirmó que es la misma configuración y que lo
 * único que cambia entre los dos flujos es el `featureType`.
 *
 * Este test existe para que no se vuelva a separar sin darse cuenta.
 */

const ENV = {
  META_APP_ID: "app-1",
  META_CONFIG_ID: "config-tubot",
  META_ES_CONFIG_ID_CONVERSIA: "config-conversia",
  META_ES_FEATURE_TYPE: "",
  META_ES_COEX_FEATURE_TYPE: "whatsapp_business_app_onboarding",
  META_GRAPH_VERSION: "v26.0",
  META_ES_V5_ENABLED_CONVERSIA: false,
  META_MESSAGING_REVIEW_APPROVED: false,
};

vi.mock("@conversia/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEnv: () => ENV,
}));

import { PublicController } from "../src/public/public.controller";

function pedir(brand: string, mode?: string) {
  const c = Object.create(PublicController.prototype) as PublicController;
  return (c.metaConfig as (b: string | undefined, m: string | undefined, r: unknown) => Record<string, unknown>)(
    brand,
    mode,
    { headers: {} } as never,
  );
}

describe("la config del Embedded Signup es UNA por marca", () => {
  for (const brand of ["conversia", "tubot"]) {
    it(`${brand}: número nuevo y coexistencia usan el MISMO config_id`, () => {
      const nuevo = pedir(brand);
      const coex = pedir(brand, "coexistence");
      expect(coex.configId).toBe(nuevo.configId);
      expect(String(nuevo.configId)).not.toBe("");
    });

    it(`${brand}: lo ÚNICO que cambia entre los dos caminos es el featureType`, () => {
      const nuevo = pedir(brand);
      const coex = pedir(brand, "coexistence");
      expect(nuevo.featureType).toBe("");
      expect(coex.featureType).toBe("whatsapp_business_app_onboarding");
      // Todo lo demás idéntico salvo la etiqueta del modo.
      const sinModo = (o: Record<string, unknown>) => {
        const { mode: _m, featureType: _f, ...resto } = o;
        return resto;
      };
      expect(sinModo(coex)).toEqual(sinModo(nuevo));
    });
  }

  it("cada marca conserva SU propia config (unificar los caminos no mezcla marcas)", () => {
    expect(pedir("conversia").configId).toBe("config-conversia");
    expect(pedir("tubot").configId).toBe("config-tubot");
    expect(pedir("conversia", "coexistence").configId).toBe("config-conversia");
    expect(pedir("tubot", "coexistence").configId).toBe("config-tubot");
  });

  it("sin config propia, conversia cae a la de la app y SIGUE siendo una sola", () => {
    const previo = ENV.META_ES_CONFIG_ID_CONVERSIA;
    ENV.META_ES_CONFIG_ID_CONVERSIA = "";
    try {
      expect(pedir("conversia").configId).toBe("config-tubot");
      expect(pedir("conversia", "coexistence").configId).toBe("config-tubot");
    } finally {
      ENV.META_ES_CONFIG_ID_CONVERSIA = previo;
    }
  });

  it("el modo se refleja igual que antes (no se rompió el contrato del front)", () => {
    expect(pedir("conversia").mode).toBe("embedded_signup");
    expect(pedir("conversia", "coexistence").mode).toBe("coexistence");
    expect(pedir("conversia", "COEXISTENCE").mode).toBe("coexistence");
    expect(pedir("conversia", "cualquier-otra-cosa").mode).toBe("embedded_signup");
  });

  it("ready sigue atado a tener app y config", () => {
    expect(pedir("conversia").ready).toBe(true);
    const previo = ENV.META_CONFIG_ID;
    ENV.META_CONFIG_ID = "";
    try {
      expect(pedir("tubot").ready).toBe(false);
    } finally {
      ENV.META_CONFIG_ID = previo;
    }
  });
});
