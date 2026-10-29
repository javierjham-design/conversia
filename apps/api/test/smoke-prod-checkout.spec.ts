import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AJUSTE FINAL §humo — el chequeo 12 de smoke-prod compara el sha que sirve producción con
 * `main` usando `git cat-file` + `git merge-base --is-ancestor`, que necesitan TODA la
 * historia. Con el checkout por defecto (shallow, profundidad 1) ese commit no está en el
 * clon y el chequeo daba un FAIL FALSO ("el commit no está en esta rama"). Este test fija
 * `fetch-depth: 0` en el workflow para que no se pueda quitar sin que algo se ponga rojo.
 */

// apps/api/test → repo root (tres niveles arriba).
const WORKFLOW = join(__dirname, "..", "..", "..", ".github", "workflows", "smoke-prod.yml");
const yml = readFileSync(WORKFLOW, "utf8");

describe("smoke-prod.yml — checkout con historia completa (chequeo 12)", () => {
  it("usa actions/checkout", () => {
    expect(yml).toMatch(/actions\/checkout@v\d+/);
  });
  it("el checkout declara fetch-depth: 0", () => {
    expect(yml).toMatch(/fetch-depth:\s*0/);
  });
});
