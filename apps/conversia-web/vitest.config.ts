import { defineConfig } from "vitest/config";

// Tests UNITARIOS de conversia-web (p. ej. lib/api.ts). Acotado a `src` para NO barrer los specs
// de Playwright (viven en `e2e/` y se corren con `playwright test`, no vitest). Entorno node: los
// helpers acceden a window/localStorage/fetch vía globals que el propio test inyecta.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    environment: "node",
  },
});
