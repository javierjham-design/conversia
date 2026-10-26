#!/usr/bin/env node
/**
 * Sello de versión (Bloque 2 de PROMPT_DEPLOY_CONVERSIA_WEB): escribe public/version.json con el
 * SHA del commit publicado + la hora de build. Next sirve public/ en la raíz → queda en
 * https://app.conversia.cl/version.json. Así se detecta en segundos si la web quedó atrasada:
 * su `sha` debe coincidir con el HEAD de main (y con el de la API).
 *
 * El SHA viene de GITHUB_SHA (en el Action) o de `git rev-parse HEAD` (deploy manual). Si no hay
 * git (p. ej. el build remoto de Railway, que recibe el archivo ya escrito), conserva "dev".
 * Correr ANTES de `railway up`:  node apps/conversia-web/scripts/stamp-version.mjs
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function resolveSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

const out = { sha: resolveSha(), builtAt: new Date().toISOString() };
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "version.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log("stamp-version →", JSON.stringify(out));
