import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B1 — EL MODELO DEL HISTORIAL DE CONVI.
 *
 * Lo que de verdad protege estas tablas se comprobó contra un Postgres real (RLS, la FK a
 * organizations que agrega `setup.sql`, el borrado en cascada y el índice que impide dos
 * hilos abiertos). Esto es el guardián de que esas propiedades sigan DECLARADAS: una
 * migración se edita una vez y nadie vuelve a mirarla.
 *
 * Por qué importa cada una:
 * - `organization_id` en ambas tablas es lo que hace que `sql/setup.sql` les ponga RLS sola.
 *   Sin esa columna no hay aislamiento entre clientes y el job `tenant-isolation` ni se entera,
 *   porque solo barre las tablas que la tienen.
 * - El índice único PARCIAL es la única garantía real de "un hilo abierto por usuario": el
 *   servidor elige el hilo con un busca-si-no-crea que dos pestañas pueden ganar a la vez.
 */

const raiz = join(__dirname, "..", "..", "..");
const MIGRACION = readFileSync(join(raiz, "packages", "database", "prisma", "migrations", "20261110030000_assistant_threads", "migration.sql"), "utf8");
const ESQUEMA = readFileSync(join(raiz, "packages", "database", "prisma", "schema.prisma"), "utf8");

/** El bloque de un modelo del schema. */
const modelo = (nombre: string): string => {
  const i = ESQUEMA.indexOf(`model ${nombre} {`);
  expect(i, `no existe el modelo ${nombre}`).toBeGreaterThan(-1);
  const fin = ESQUEMA.indexOf("\n}", i);
  return ESQUEMA.slice(i, fin);
};

describe("las dos tablas quedan bajo RLS por construcción", () => {
  it.each(["assistant_threads", "assistant_messages"])("%s tiene organization_id", (tabla) => {
    const i = MIGRACION.indexOf(`CREATE TABLE IF NOT EXISTS "${tabla}"`);
    expect(i).toBeGreaterThan(-1);
    const bloque = MIGRACION.slice(i, MIGRACION.indexOf(");", i));
    expect(bloque, `${tabla} sin organization_id: setup.sql no le pondría RLS`).toContain('"organization_id" TEXT NOT NULL');
  });

  it.each([
    ["AssistantThread", "assistant_threads"],
    ["AssistantMessage", "assistant_messages"],
  ])("el modelo %s mapea a %s y declara organizationId", (nombre, tabla) => {
    const m = modelo(nombre);
    expect(m).toContain(`@@map("${tabla}")`);
    expect(m).toContain('@map("organization_id")');
  });
});

describe("un solo hilo ABIERTO por usuario, garantizado por la base", () => {
  it("el índice único es PARCIAL sobre status = open", () => {
    // Si dejara de ser parcial, archivar y abrir otro hilo fallaría: el dueño no podría
    // empezar una conversación nueva nunca más.
    expect(MIGRACION).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,200}"assistant_threads"\s*\("organization_id",\s*"user_id"\)[\s\S]{0,80}WHERE\s+"status"\s*=\s*'open'/);
  });

  it("el índice de la lista del historial ordena por última actividad", () => {
    expect(MIGRACION).toMatch(/CREATE INDEX[\s\S]{0,160}"assistant_threads"\s*\("organization_id",\s*"user_id",\s*"last_message_at"\)/);
    expect(modelo("AssistantThread")).toContain("@@index([organizationId, userId, lastMessageAt])");
  });
});

describe("los mensajes cuelgan del hilo", () => {
  it("borrar el hilo se lleva sus mensajes (sin huérfanos)", () => {
    expect(MIGRACION).toMatch(/FOREIGN KEY \("thread_id"\) REFERENCES "assistant_threads"\("id"\) ON DELETE CASCADE/);
    expect(modelo("AssistantMessage")).toContain("onDelete: Cascade");
  });

  it("se pueden leer en orden y paginar", () => {
    expect(MIGRACION).toMatch(/CREATE INDEX[\s\S]{0,140}"assistant_messages"\s*\("thread_id",\s*"created_at"\)/);
    expect(modelo("AssistantMessage")).toContain("@@index([threadId, createdAt])");
  });
});

describe("del adjunto solo se guardan los metadatos", () => {
  it("la migración lo dice y el modelo también", () => {
    // El archivo vive donde ya vivía; acá solo tipo y nombre. Si alguien guardara el
    // contenido, el historial pasaría a ser un almacén de archivos sin quererlo.
    expect(MIGRACION).toMatch(/Solo metadatos del adjunto/i);
    expect(modelo("AssistantMessage")).toMatch(/SOLO metadatos del adjunto/i);
  });
});

describe("la migración es aditiva y reversible", () => {
  it("no toca ninguna tabla existente", () => {
    // Sin comentarios: la reversa va escrita en uno, y un DROP comentado no borra nada.
    const sql = MIGRACION.replace(/^\s*--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "(?!assistant_)/);
  });

  it("deja escrita la reversa", () => {
    expect(MIGRACION).toMatch(/DROP TABLE "assistant_messages"/);
  });
});
