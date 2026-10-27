import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { EMPTY_SETUP_FACTS, buildSetupSteps } from "./setup-checklist";

/**
 * ETAPA 0 — TEST DE RUTAS. Hallazgo 4 de la auditoría: los CTAs del checklist apuntaban a
 * rutas de TuBot (`/channels`, `/billing`, `/agents`, `/settings/users`) que NO existen en
 * conversia-web, así que el cliente guiado terminaba en un 404.
 *
 * Este test recorre TODOS los `href` del checklist y los resuelve contra el árbol REAL de
 * páginas de `apps/conversia-web/src/app` (una ruta existe si hay `page.tsx`). Si un `href`
 * no existe, el arreglo es el `href` — nunca el test.
 */

/** Sube desde el cwd hasta encontrar la raíz del monorepo (sirva cwd=apps/api o la raíz). */
function findWebAppDir(): string {
  const target = join("apps", "conversia-web", "src", "app");
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, target);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No encontré ${target} subiendo desde ${process.cwd()}`);
}

/** Rutas reales de la app (Next App Router): una por cada `page.tsx`. */
function collectRoutes(appDir: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Los grupos de rutas `(nombre)` no agregan segmento a la URL.
        const isGroup = /^\(.+\)$/.test(entry.name);
        walk(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
      } else if (/^page\.(tsx|jsx|ts|js)$/.test(entry.name)) {
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(appDir, []);
  return routes;
}

/** ¿El href corresponde a una ruta real? Ignora query/hash y acepta segmentos dinámicos. */
function routeExists(href: string, routes: string[]): boolean {
  const path = href.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  const parts = path.split("/");
  return routes.some((route) => {
    const rp = route.split("/");
    if (rp.length !== parts.length) return false;
    return rp.every((seg, i) => seg === parts[i] || /^\[.+\]$/.test(seg));
  });
}

const ROUTES = collectRoutes(findWebAppDir());

/** Todos los href que el checklist puede devolver (con y sin agenda). */
function allHrefs(): { key: string; href: string }[] {
  const steps = [
    ...buildSetupSteps({ ...EMPTY_SETUP_FACTS, agendaModule: true }),
    ...buildSetupSteps({ ...EMPTY_SETUP_FACTS, agendaModule: false }),
  ];
  const seen = new Set<string>();
  return steps
    .flatMap((s) => [
      { key: s.key, href: s.href },
      { key: `${s.key}.cta`, href: s.cta.href },
    ])
    .filter((x) => {
      const id = `${x.key}|${x.href}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

describe("href del checklist de montaje ↔ rutas reales de conversia-web", () => {
  it("el árbol de rutas se leyó de verdad (si esto falla, el test no está probando nada)", () => {
    expect(ROUTES.length).toBeGreaterThan(10);
    for (const conocida of ["/inicio", "/canales", "/cobros", "/ajustes", "/agenda/configurar", "/conversaciones", "/mini-sitio"]) {
      expect(ROUTES, `falta la ruta conocida ${conocida}`).toContain(conocida);
    }
  });

  it("cada paso manda a una pantalla que EXISTE", () => {
    const roto = allHrefs().filter((x) => !routeExists(x.href, ROUTES));
    expect(roto.map((x) => `${x.key} → ${x.href}`)).toEqual([]);
  });

  it("ningún href apunta a las rutas de TuBot que no existen acá (hallazgo 4)", () => {
    const deTubot = ["/channels", "/billing", "/agents", "/workflows", "/settings/users", "/onboarding"];
    const hrefs = allHrefs().map((x) => x.href.split("?")[0]);
    expect(hrefs.filter((h) => deTubot.includes(h))).toEqual([]);
    // Y de paso: esas rutas realmente no existen en conversia-web (si alguna se crea, revisar).
    expect(deTubot.filter((r) => ROUTES.includes(r))).toEqual([]);
  });

  it("los href son rutas internas absolutas (nada de enlaces externos ni relativos)", () => {
    for (const { key, href } of allHrefs()) {
      expect(href.startsWith("/"), `${key} → ${href}`).toBe(true);
      expect(href.startsWith("//")).toBe(false);
    }
  });
});
