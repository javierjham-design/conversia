import { describe, expect, it } from "vitest";
import {
  applyDraftToOrganization,
  promptConScrape,
  scrapedTextFrom,
  type ApplyDraftTx,
} from "./apply-draft";

/**
 * COP Etapa 0 (hallazgo 5) — lo que el cliente cargó en `/crear` no puede perderse.
 * Antes solo sobrevivía el rubro: el cliente probaba un bot que hablaba de SU negocio y
 * al registrarse recibía uno genérico.
 */

function fakeTx(
  settings: Record<string, unknown>,
  versions: Array<{ id: string; systemPrompt: string | null; status?: string }>,
) {
  const updatedOrg: Array<Record<string, unknown>> = [];
  const updatedVersions: Array<{ id: string; systemPrompt: string }> = [];
  const queries: Array<Record<string, unknown>> = [];
  const tx: ApplyDraftTx = {
    organization: {
      findUnique: async () => ({ settings }),
      update: async ({ data }: any) => {
        updatedOrg.push(data.settings);
        return data;
      },
    },
    agentVersion: {
      findMany: async (args: any) => {
        queries.push(args.where);
        return versions.filter((v) => (v.status ?? "DRAFT") === args.where.status);
      },
      update: async ({ where, data }: any) => {
        updatedVersions.push({ id: where.id, systemPrompt: data.systemPrompt });
        return data;
      },
    },
  };
  return { tx, updatedOrg, updatedVersions, queries };
}

const TEXTO = "Clínica Sonrisa. Atendemos de lunes a viernes de 9 a 18 en Manuel Montt 820, Temuco. Implantes desde $450.000.";

describe("scrapedTextFrom", () => {
  it("toma el texto del borrador", () => {
    expect(scrapedTextFrom({ scrapedText: TEXTO })).toBe(TEXTO);
  });
  it("ignora textos insignificantes o ausentes", () => {
    expect(scrapedTextFrom({ scrapedText: "hola" })).toBeNull();
    expect(scrapedTextFrom({})).toBeNull();
    expect(scrapedTextFrom(null)).toBeNull();
  });
  it("acota a 2.000 caracteres", () => {
    expect(scrapedTextFrom({ scrapedText: "x".repeat(5000) })?.length).toBe(2000);
  });
});

describe("promptConScrape", () => {
  it("ANEXA, no pisa lo que trae el paquete del rubro", () => {
    const r = promptConScrape("Eres la recepción de la clínica.", TEXTO);
    expect(r).toContain("Eres la recepción de la clínica.");
    expect(r).toContain(TEXTO);
  });
  it("es idempotente: no duplica el bloque", () => {
    const primera = promptConScrape("Base.", TEXTO)!;
    expect(promptConScrape(primera, TEXTO)).toBeNull();
  });
});

describe("applyDraftToOrganization", () => {
  it("guarda web, nombre y texto del sitio sin pisar el resto de settings", async () => {
    const { tx, updatedOrg } = fakeTx({ general: { industry: "dental" }, business: { otro: 1 } }, []);
    await applyDraftToOrganization(tx, "org-1", {
      businessName: "Clínica Sonrisa",
      website: "https://sonrisa.cl",
      config: { scrapedText: TEXTO },
    });
    const s = updatedOrg[0] as any;
    expect(s.general).toEqual({ industry: "dental" }); // intacto
    expect(s.business.otro).toBe(1); // intacto
    expect(s.business.website).toBe("https://sonrisa.cl");
    expect(s.business.nombre).toBe("Clínica Sonrisa");
    expect(s.business.scrapedText).toBe(TEXTO);
  });

  it("anexa el texto del sitio al prompt de los agentes instalados (en BORRADOR)", async () => {
    const { tx, updatedVersions, queries } = fakeTx({}, [
      { id: "v1", systemPrompt: "Prompt del rubro." },
      { id: "v2", systemPrompt: "Otro agente del rubro." },
    ]);
    const r = await applyDraftToOrganization(tx, "org-1", {
      businessName: "N",
      website: null,
      config: { scrapedText: TEXTO },
    });
    expect(r.agentsUpdated).toBe(2);
    expect(queries[0]).toMatchObject({ organizationId: "org-1", status: "DRAFT" }); // solo borradores, solo de esta org
    expect(updatedVersions[0].systemPrompt).toContain("Prompt del rubro.");
    expect(updatedVersions[0].systemPrompt).toContain(TEXTO);
  });

  it("sin texto del sitio no toca ningún agente (pero igual guarda la web)", async () => {
    const { tx, updatedVersions, updatedOrg } = fakeTx({}, [{ id: "v1", systemPrompt: "Prompt." }]);
    const r = await applyDraftToOrganization(tx, "org-1", {
      businessName: "N",
      website: "https://x.cl",
      config: {},
    });
    expect(r.agentsUpdated).toBe(0);
    expect(updatedVersions).toHaveLength(0);
    expect((updatedOrg[0] as any).business.website).toBe("https://x.cl");
  });

  it("correrlo dos veces no duplica el bloque en el prompt", async () => {
    const primera = promptConScrape("Prompt del rubro.", TEXTO)!;
    const { tx, updatedVersions } = fakeTx({}, [{ id: "v1", systemPrompt: primera }]);
    const r = await applyDraftToOrganization(tx, "org-1", {
      businessName: "N",
      website: null,
      config: { scrapedText: TEXTO },
    });
    expect(r.agentsUpdated).toBe(0);
    expect(updatedVersions).toHaveLength(0);
  });
});
