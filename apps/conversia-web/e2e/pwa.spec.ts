import { test, expect } from "@playwright/test";

/* M5 — PWA instalable + SW. No necesita backend (sirve contra `next start`). Es el subconjunto
 * que corre en CI. Los flujos con API viven en flows.spec.ts (se saltan si no hay API). */

test("manifest instalable (192/512 PNG + maskable + shortcuts)", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  expect(href).toBeTruthy();
  const m = await (await page.request.get(href!)).json();
  expect(m.display).toBe("standalone");
  expect(m.start_url).toBe("/inicio");
  const icons: any[] = m.icons || [];
  expect(icons.some((i) => i.sizes === "192x192" && i.type === "image/png")).toBeTruthy();
  expect(icons.some((i) => i.sizes === "512x512" && i.type === "image/png")).toBeTruthy();
  expect(icons.some((i) => (i.purpose || "").includes("maskable") && i.type === "image/png")).toBeTruthy();
  expect((m.shortcuts || []).length).toBeGreaterThanOrEqual(3);
});

test("iconos PNG y apple-touch-icon se sirven", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  for (const path of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]) {
    const r = await page.request.get(path);
    expect(r.status(), path).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
  }
  expect(await page.locator('link[rel="apple-touch-icon"]').count()).toBeGreaterThan(0);
  expect(await page.getAttribute('meta[name="theme-color"]', "content")).toBe("#0f2027");
});

test("service worker queda activo y controla la página", async ({ page }) => {
  await page.goto("/login", { waitUntil: "load" });
  const state = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "no-sw";
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then(() => "ready"),
      new Promise((r) => setTimeout(() => r("timeout"), 12000)),
    ]);
    const regs = await navigator.serviceWorker.getRegistrations();
    return `${reg}:${regs[0]?.active ? "active" : "inactive"}`;
  });
  expect(state).toBe("ready:active");
});

test("página offline disponible", async ({ page }) => {
  const r = await page.request.get("/offline.html");
  expect(r.status()).toBe(200);
  expect((await r.text()).toLowerCase()).toContain("conexión");
});

test("sin scroll horizontal en móvil/escritorio (login y crear)", async ({ page }) => {
  for (const path of ["/login", "/crear"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflow`).toBeLessThanOrEqual(1);
  }
});

test("el funnel /crear renderiza el hero sin bloquear", async ({ page }) => {
  await page.goto("/crear", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1.display")).toBeVisible();
});
