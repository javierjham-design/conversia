import { defineConfig, devices } from "@playwright/test";

/* M5 — e2e de conversia-web (PWA móvil + escritorio). Contra el stack Docker local (M6) o
 * un `next start`. BASE define el objetivo; nunca producción. Proyectos móvil (iPhone 13 /
 * Pixel 7) + escritorio, en claro y oscuro. El tema se fija por localStorage antes del paint. */

const BASE = process.env.BASE || "http://localhost:3002";

// Fija el tema (el bootstrap del layout lee localStorage) antes de cargar la página.
const themeInit = (theme: "dark" | "light") => ({
  storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "conversia_theme", value: theme }] }] },
});

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE, trace: "on-first-retry", ignoreHTTPSErrors: true },
  // Emulación (viewport + táctil + UA) sobre Chromium en TODOS los proyectos → un solo motor
  // en CI (sin WebKit), que es lo que pide "iPhone/Pixel emulados".
  projects: [
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium", ...themeInit("dark") } },
    { name: "iphone-light", use: { ...devices["iPhone 13"], browserName: "chromium", ...themeInit("light") } },
    { name: "pixel", use: { ...devices["Pixel 7"], browserName: "chromium", ...themeInit("dark") } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 }, ...themeInit("dark") } },
    { name: "desktop-light", use: { viewport: { width: 1280, height: 800 }, ...themeInit("light") } },
  ],
});
