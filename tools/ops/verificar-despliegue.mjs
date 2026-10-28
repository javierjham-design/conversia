#!/usr/bin/env node
/**
 * ¿Producción sirve REALMENTE este commit?
 *
 * Por qué existe (28-oct-2026): el workflow deploy-conversia-web terminaba cuando `railway up`
 * devolvía 0, y eso no es lo mismo que "la web nueva está arriba". Ese día pasaron las dos
 * variantes del mismo error en un solo día:
 *   · sin RAILWAY_TOKEN el job no desplegaba nada y daba verde (lo arregló #570);
 *   · con el token puesto, el builder de Railway falló tras 24 minutos y producción se quedó
 *     sirviendo un commit de la mañana, con arreglos de cobro ya mergeados en main.
 * El único hecho que vale es el que se puede leer desde afuera: /version.json. Este script lo
 * consulta hasta que aparezca el SHA esperado, y si no aparece, falla.
 *
 * Uso:
 *   node tools/ops/verificar-despliegue.mjs [url] [--sha=<sha>] [--intentos=N] [--espera=ms]
 *   node tools/ops/verificar-despliegue.mjs --autoprueba     (prueba la lógica, sin red)
 *
 * El SHA esperado sale de --sha, de GITHUB_SHA o de `git rev-parse HEAD`, en ese orden.
 */
import { execFileSync } from "node:child_process";

const URL_POR_DEFECTO = "https://app.conversia.cl/version.json";
const INTENTOS_POR_DEFECTO = 20;
const ESPERA_POR_DEFECTO_MS = 15_000;

const SHA_VALIDO = /^[0-9a-f]{7,40}$/;

/** Dos SHA son el mismo commit si uno es prefijo del otro (git abrevia a 7-12 chars). */
export function mismoCommit(a, b) {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  if (!SHA_VALIDO.test(x) || !SHA_VALIDO.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Consulta la URL hasta que sirva `esperado` o se acaben los intentos.
 * Un error de red NO aborta: justo después de un deploy el servicio puede estar reiniciando.
 */
export async function esperarSha({
  url = URL_POR_DEFECTO,
  esperado,
  intentos = INTENTOS_POR_DEFECTO,
  esperaMs = ESPERA_POR_DEFECTO_MS,
  fetchImpl = globalThis.fetch,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  if (!SHA_VALIDO.test(String(esperado ?? "").toLowerCase())) {
    return { ok: false, motivo: `sha esperado inválido: ${JSON.stringify(esperado)}`, intentos: 0, sha: null };
  }
  let ultimo = null;
  for (let i = 1; i <= intentos; i++) {
    let sha = null;
    try {
      const r = await fetchImpl(`${url}?t=${Date.now()}`, { cache: "no-store" });
      const data = await r.json();
      sha = String(data?.sha ?? "");
      ultimo = sha;
    } catch (e) {
      ultimo = `ERROR ${e.message}`;
    }
    if (sha && mismoCommit(sha, esperado)) {
      log(`intento ${i}/${intentos}: producción sirve ${sha.slice(0, 8)} ✔`);
      return { ok: true, motivo: null, intentos: i, sha };
    }
    log(`intento ${i}/${intentos}: producción sirve ${ultimo || "(nada)"}, esperando ${String(esperado).slice(0, 8)}…`);
    if (i < intentos) await dormir(esperaMs);
  }
  return {
    ok: false,
    motivo: `tras ${intentos} intento(s) producción sigue sirviendo ${ultimo || "(nada)"} y no ${String(esperado).slice(0, 8)}`,
    intentos,
    sha: ultimo,
  };
}

function shaEsperado(argv) {
  const arg = argv.find((a) => a.startsWith("--sha="));
  if (arg) return arg.slice("--sha=".length);
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// ── Autoprueba ────────────────────────────────────────────────────────────────
// Corre en CI sin red: si alguien rompe la comparación de SHA, esto se pone rojo.
async function autoprueba() {
  const NUEVO = "ed85b6f3a20e9ec24364d113190bf62f42e91985";
  const VIEJO = "28e2a5f5c1b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6";
  const fallos = [];
  const comprobar = (nombre, cond, detalle = "") => {
    if (cond) console.log(`  ✔ ${nombre}`);
    else {
      console.log(`  ✘ ${nombre}${detalle ? ` — ${detalle}` : ""}`);
      fallos.push(nombre);
    }
  };
  const sirviendo = (...shas) => {
    let i = 0;
    return async () => {
      const sha = shas[Math.min(i++, shas.length - 1)];
      if (sha instanceof Error) throw sha;
      return { json: async () => (sha === null ? {} : { sha }) };
    };
  };
  const yaMismo = { intentos: 4, esperaMs: 0, dormir: async () => {} };

  let r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(NUEVO), ...yaMismo });
  comprobar("pasa al primer intento si ya está desplegado", r.ok && r.intentos === 1, JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(VIEJO, VIEJO, NUEVO), ...yaMismo });
  comprobar("espera a que Railway cambie el tráfico", r.ok && r.intentos === 3, JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(VIEJO), ...yaMismo });
  comprobar("FALLA si producción se queda en el commit viejo", !r.ok && /28e2a5f5/.test(r.motivo), JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(new Error("ECONNREFUSED")), ...yaMismo });
  comprobar("FALLA si la web nunca responde", !r.ok && /ECONNREFUSED/.test(r.motivo), JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(new Error("reiniciando"), NUEVO), ...yaMismo });
  comprobar("un error de red suelto no aborta (el servicio reinicia)", r.ok && r.intentos === 2, JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(NUEVO.slice(0, 7)), ...yaMismo });
  comprobar("acepta el SHA abreviado", r.ok, JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo("dev"), ...yaMismo });
  comprobar('FALLA con el sello "dev" (build sin sellar)', !r.ok, JSON.stringify(r));

  r = await esperarSha({ esperado: NUEVO, fetchImpl: sirviendo(null), ...yaMismo });
  comprobar("FALLA si version.json no trae sha", !r.ok, JSON.stringify(r));

  r = await esperarSha({ esperado: "", fetchImpl: sirviendo(NUEVO), ...yaMismo });
  comprobar("FALLA sin sha esperado, en vez de dar verde", !r.ok && r.intentos === 0, JSON.stringify(r));

  comprobar("no confunde dos commits distintos", !mismoCommit(NUEVO, VIEJO));

  if (fallos.length) {
    console.error(`\nAutoprueba de verificar-despliegue: ${fallos.length} fallo(s).`);
    process.exit(1);
  }
  console.log("\nAutoprueba de verificar-despliegue: todo bien.");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--autoprueba")) return autoprueba();

  const url = argv.find((a) => !a.startsWith("--")) ?? URL_POR_DEFECTO;
  const num = (bandera, def) => {
    const a = argv.find((x) => x.startsWith(`--${bandera}=`));
    return a ? Number(a.slice(bandera.length + 3)) : def;
  };
  const esperado = shaEsperado(argv);

  console.log(`Verificando que ${url} sirva ${String(esperado).slice(0, 8)}…`);
  const r = await esperarSha({
    url,
    esperado,
    intentos: num("intentos", INTENTOS_POR_DEFECTO),
    esperaMs: num("espera", ESPERA_POR_DEFECTO_MS),
    log: (m) => console.log(`  ${m}`),
  });

  if (r.ok) {
    console.log(`✔ producción sirve ${r.sha.slice(0, 8)}`);
    return;
  }
  console.log("");
  console.log(`::error title=El deploy NO llegó a producción::${r.motivo}`);
  console.log("");
  console.log("Qué mirar, en este orden:");
  console.log("  1) El deploy en el dashboard de Railway (servicio conversia-web): si dice");
  console.log("     'Failed to build an image', fue el builder y basta con volver a correr este workflow.");
  console.log("  2) Si el build pasó pero el servicio no arranca: railway logs -s conversia-web -d");
  console.log("  3) Para desplegar a mano:");
  console.log("     node apps/conversia-web/scripts/stamp-version.mjs && railway up --service conversia-web --ci");
  process.exit(1);
}

main().catch((e) => {
  console.error(`Error fatal: ${e.stack || e.message}`);
  process.exit(2);
});
