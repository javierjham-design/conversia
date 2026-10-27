#!/usr/bin/env node
/**
 * Arranca el grafo de dependencias de Nest del api SIN escuchar en un puerto y sin tocar
 * la base: Nest resuelve e instancia todos los providers en `NestFactory.create`, antes
 * de `onModuleInit`, así que un error de inyección se ve acá.
 *
 * POR QUÉ EXISTE (27-oct-2026): un constructor con parámetros opcionales en TS pero sin
 * `@Optional()` dejó a Nest buscando un provider inexistente y el proceso del api MORÍA
 * al arrancar. No lo vio nadie: `tsc` compila bien, y los unit tests tampoco pueden
 * verlo porque vitest transpila con esbuild, que NO emite `design:paramtypes` (la
 * metadata que causa el problema solo la emite tsc). Se descubrió recién en el stack
 * Docker, con 4 minutos de espera y sin logs. Esto lo convierte en un fallo de 1 segundo.
 *
 * Uso: node tools/ops/check-di.cjs [ruta de apps/api]
 * Requiere `dist/` ya construido (correr después del build).
 */
const path = require("node:path");
const fs = require("node:fs");

const API = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "apps", "api"));
const DIST = path.join(API, "dist", "app.module.js");

if (!fs.existsSync(DIST)) {
  console.error(`✖ No existe ${DIST}. Construí el api antes (pnpm --filter @conversia/api build).`);
  process.exit(2);
}

/*
 * Nada de esto se CONECTA: el constructor de PrismaClient solo valida que la URL exista
 * (`getAdminPrisma` lee `process.env` directo, sin pasar por el default de `getEnv()`), y
 * el cliente de Redis se crea con `lazyConnect`. Se rellenan acá para que el chequeo
 * corra en una máquina limpia o en CI, donde no hay `.env`: lo que se comprueba es el
 * grafo de dependencias, no que haya base de datos.
 */
process.env.DATABASE_URL ||= "postgresql://chequeo:chequeo@127.0.0.1:5432/chequeo?schema=public";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379";

require(path.join(API, "node_modules/reflect-metadata"));

(async () => {
  try {
    const { NestFactory } = require(path.join(API, "node_modules/@nestjs/core"));
    const { AppModule } = require(DIST);
    // Sin `abortOnError: false` A PROPÓSITO: con esa opción Nest LOGUEA el error de
    // inyección y devuelve la app igual, y el chequeo pasaría en falso.
    const app = await NestFactory.create(AppModule, { logger: ["error"] });
    console.log("✓ El grafo de dependencias de Nest se resuelve (api)");
    await app.close();
    process.exit(0);
  } catch (e) {
    console.error("✖ El api NO arrancaría: Nest no puede resolver sus dependencias.\n");
    console.error(String((e && e.message) || e).slice(0, 3000));
    process.exit(1);
  }
})();
