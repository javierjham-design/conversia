/**
 * Captura de referencia visual del panel (Bloque 0 de la armonización de UI).
 * Recorre TODAS las pantallas en claro y oscuro contra un build de producción
 * con la API mockeada (mismo patrón que e2e/robustness) y guarda screenshots en
 * docs/ui-baseline/<modo>/<pantalla>.png — son el "antes" contra el que se
 * comparan los bloques de armonización.
 *
 *   pnpm --filter @conversia/web build
 *   pnpm --filter @conversia/web start -p 3010
 *   BASE=http://localhost:3010 node apps/web/e2e/ui-baseline/capture.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { nullsBody } from "../robustness/nulls-mock.mjs";

const BASE = process.env.BASE || "http://localhost:3010";
const OUT = process.env.OUT || join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/ui-baseline");

const PAGES = [
  ["inbox", "/inbox"],
  ["contacts", "/contacts"],
  ["crm", "/crm"],
  ["agents", "/agents"],
  ["agents-editor", "/agents/a1"],
  ["workflows", "/workflows"],
  ["workflows-canvas", "/workflows/w1"],
  ["catalog", "/catalog"],
  ["channels", "/channels"],
  ["integrations", "/integrations"],
  ["integrations-meta", "/integrations/meta"],
  ["integrations-meta-crm", "/integrations/meta-crm"],
  ["reports", "/reports"],
  ["billing", "/billing"],
  ["settings", "/settings"],
  ["settings-general", "/settings/general"],
  ["settings-personalization", "/settings/personalization"],
  ["settings-plan", "/settings/plan"],
  ["settings-users", "/settings/users"],
  ["settings-teams", "/settings/teams"],
  ["settings-lifecycle", "/settings/lifecycle"],
  ["settings-contact-fields", "/settings/contact-fields"],
  ["settings-tags", "/settings/tags"],
  ["settings-snippets", "/settings/snippets"],
  ["settings-ia", "/settings/ia"],
  ["settings-conversations", "/settings/conversations"],
  ["settings-notifications", "/settings/notifications"],
  ["settings-hours", "/settings/hours"],
  ["settings-import", "/settings/import"],
  ["settings-export", "/settings/export"],
  ["settings-data", "/settings/data"],
  ["settings-assisted-setup", "/settings/assisted-setup"],
  ["settings-audit", "/settings/audit"],
  ["settings-profile", "/settings/profile"],
];

const browser = await chromium.launch();
for (const mode of ["light", "dark"]) {
  mkdirSync(join(OUT, mode), { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode });
  await ctx.addInitScript((m) => {
    localStorage.setItem("tubot-theme", m);
    localStorage.setItem("conversia_token", "mock.jwt.token");
  }, mode);
  const page = await ctx.newPage();
  await page.route("**/backend/**", async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(nullsBody(u.pathname.replace(/^\/backend/, ""))),
    });
  });
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, mode, `${name}.png`), fullPage: true }).catch((e) => {
      console.error(`✖ ${mode}/${name}: ${e.message}`);
    });
    console.log(`📸 ${mode}/${name}`);
  }
  await ctx.close();
}
await browser.close();
console.log(`\nBaseline guardado en ${OUT}`);
