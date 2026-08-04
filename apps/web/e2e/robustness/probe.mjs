/**
 * Smoke de robustez: carga las pantallas del panel con datos DELIBERADAMENTE
 * incompletos (tenant vacío y registros con null) y falla si alguna revienta
 * (pageerror). Complementa a los tests unitarios de src/lib/safe.test.ts.
 *
 * Requiere un servidor de PRODUCCIÓN corriendo (no `next dev`):
 *   pnpm --filter @conversia/web build && pnpm --filter @conversia/web start -p 3010
 *   BASE=http://localhost:3010 node apps/web/e2e/robustness/probe.mjs
 *
 * Nota: DEBE ser `next start`. La CSP de producción prohíbe `unsafe-eval`, y el
 * HMR de `next dev` usa eval → no hidrata bajo esa CSP (la página queda en
 * blanco). Ver next.config.mjs.
 */
import { chromium } from "playwright";
import { emptyBody } from "./empty-mock.mjs";
import { nullsBody } from "./nulls-mock.mjs";

const BASE = process.env.BASE || "http://localhost:3010";
const PAGES = [
  ["inbox", "/inbox"], ["contacts", "/contacts"], ["settings", "/settings"],
  ["settings-general", "/settings/general"], ["settings-users", "/settings/users"],
  ["settings-hours", "/settings/hours"], ["integrations", "/integrations"],
  ["agents", "/agents"], ["agents-editor", "/agents/a1"], ["workflows", "/workflows"],
  ["workflows-canvas", "/workflows/w1"], ["billing", "/billing"], ["reports", "/reports"],
];
const SCENARIOS = [["VACÍO", emptyBody], ["NULLS", nullsBody]];

const browser = await chromium.launch();
let failures = 0;
for (const [label, fn] of SCENARIOS) {
  console.log(`\n########## ESCENARIO: ${label} ##########`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  await ctx.addInitScript(() => { localStorage.setItem("tubot-theme", "dark"); localStorage.setItem("conversia_token", "mock.jwt.token"); });
  const page = await ctx.newPage();
  await page.route("**/backend/**", async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fn(u.pathname.replace(/^\/backend/, ""))) });
  });
  for (const [name, path] of PAGES) {
    const errs = [];
    page.removeAllListeners("pageerror");
    page.on("pageerror", (e) => errs.push((e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (errs.length) failures++;
    console.log(`${errs.length ? "❌" : "✅"} ${name.padEnd(18)} ${errs[0] || ""}`);
  }
  await ctx.close();
}
await browser.close();
if (failures) { console.error(`\n${failures} pantalla(s) reventaron con datos incompletos.`); process.exit(1); }
console.log("\nTodas las pantallas resisten datos incompletos ✔");
