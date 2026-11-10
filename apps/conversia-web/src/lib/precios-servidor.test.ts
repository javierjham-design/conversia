import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { leerCatalogo, REVALIDAR_SEGUNDOS } from "./precios-servidor";

/**
 * El precio tiene que venir EN EL HTML, no después.
 *
 * La portada es prerenderizada: si el precio lo pide solo el navegador, el HTML que se sirve
 * —el que indexa Google y el que abre el revisor de anuncios de Meta— sale con lo que haya en
 * el estado inicial. Por eso el servidor lee el catálogo activo y lo pasa como estado inicial.
 *
 * Y si esa lectura falla, devuelve `null` a propósito: la página muestra la sección sin
 * precio, que es honesto, en vez de un número que nadie puede sostener.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const V2 = { code: "conversia_v2_base", priceClp: 18_900, features: { conversationsIncluded: 30 } };
const CREDITOS = { code: "conversia_creditos_base", priceClp: 24_990, features: { aiCreditsIncluded: 300 } };
const PACKS = [{ code: "conversia-cred-420", credits: 420, priceClp: 24_990, creditosPorConversacion: 4.5 }];

beforeEach(() => {
  fetchMock = vi.fn();
  (globalThis as any).fetch = fetchMock;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).fetch;
});

describe("leerCatalogo", () => {
  it("devuelve el plan activo y los packs", async () => {
    fetchMock.mockResolvedValueOnce(ok([V2])).mockResolvedValueOnce(ok(PACKS));
    const cat = await leerCatalogo();
    expect(cat?.base?.code).toBe("conversia_v2_base");
    expect(cat?.packs).toHaveLength(1);
  });

  it("pregunta por la marca conversia a la API pública", async () => {
    fetchMock.mockResolvedValueOnce(ok([V2])).mockResolvedValueOnce(ok([]));
    await leerCatalogo();
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://api.test/public/plans?brand=conversia");
  });

  it("prefiere el catálogo de créditos si está encendido", async () => {
    fetchMock.mockResolvedValueOnce(ok([V2, CREDITOS])).mockResolvedValueOnce(ok(PACKS));
    const cat = await leerCatalogo();
    expect(cat?.base?.code).toBe("conversia_creditos_base");
  });

  it("si la llamada FALLA devuelve null: mejor sin precio que con uno inventado", async () => {
    fetchMock.mockRejectedValue(new Error("api caída"));
    expect(await leerCatalogo()).toBeNull();
  });

  it("un HTTP distinto de 200 también es null", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    expect(await leerCatalogo()).toBeNull();
  });

  it("una respuesta sin el plan Base es null, no un plan a medias", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ code: "otro", priceClp: 1 }])).mockResolvedValueOnce(ok([]));
    expect(await leerCatalogo()).toBeNull();
  });

  it("si los packs fallan pero el plan llega, sirve el plan (el precio es lo que importa)", async () => {
    fetchMock.mockResolvedValueOnce(ok([V2])).mockRejectedValueOnce(new Error("sin packs"));
    const cat = await leerCatalogo();
    expect(cat?.base?.code).toBe("conversia_v2_base");
    expect(cat?.packs).toEqual([]);
  });

  it("nunca deja que una api lenta cuelgue el renderizado (lleva timeout)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./precios-servidor.ts", import.meta.url), "utf8");
    expect(src).toMatch(/AbortSignal\.timeout|AbortController/);
  });
});

describe("la portada revalida con el mismo número que la lectura", () => {
  it("`export const revalidate` de app/page.tsx = REVALIDAR_SEGUNDOS", async () => {
    // Next exige un literal en `revalidate` (un identificador importado rompe el build), así
    // que el número está escrito dos veces. Esto es lo que impide que se separen: si alguien
    // cambia uno, la página revalidaría a un ritmo distinto del que dice el módulo.
    const src = (await import("node:fs")).readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    const m = /export const revalidate = (\d+)/.exec(src);
    expect(m, "app/page.tsx ya no exporta `revalidate`: la portada dejó de refrescar el precio").not.toBeNull();
    expect(Number(m![1])).toBe(REVALIDAR_SEGUNDOS);
  });

  it("la portada lee el catálogo en el servidor", async () => {
    // Si alguien vuelve a hacer la portada 100% cliente, el HTML sale sin precio y el número
    // aparece recién al hidratar — el camino exacto por el que se sirvió un precio falso.
    const src = (await import("node:fs")).readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    // La LLAMADA, no el import: con `expect(src).toContain("leerCatalogo")` el test seguía
    // verde después de reemplazar la llamada por `const inicial = null`, porque el import
    // seguía ahí. Un guardián que no se cae cuando rompés lo que vigila no vigila nada.
    // C2 — la llamada puede ir dentro de un `Promise.all` (ahora también se lee si Meta
    // aprobó la mensajería), pero tiene que seguir siendo una llamada AWAITED.
    expect(src).toMatch(/await[\s\S]{0,120}leerCatalogo\(\)/);
    expect(src).toMatch(/<Landing\s+inicial=\{inicial\}/);
    expect(src).not.toContain('"use client"');
  });

  it("la promesa de Instagram y Messenger se decide EN EL SERVIDOR", async () => {
    // Igual que el precio: si la portada promete multicanal desde el cliente, el HTML que
    // ve Google —y el revisor de anuncios de Meta— lo prometería siempre.
    const src = (await import("node:fs")).readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/multicanalAprobado\(\)/);
    expect(src).toMatch(/multicanal=\{multicanal\}/);
  });
});
