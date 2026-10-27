#!/usr/bin/env node
/**
 * clean-queues.mjs — Limpieza de jobs VIEJOS de las colas BullMQ (auditoría §8.2).
 *
 * LO CORRE EL DUEÑO, A MANO Y FUERA DE HORARIO. No es un cron ni lo llama la app:
 * TuBot atiende clientes reales 24/7 y `clean` corre un script Lua que bloquea Redis
 * mientras borra. En horario punta eso frena la cola de salida. Hacerlo de noche.
 *
 * PARA QUÉ: desde la corrección §8.2 las colas nacen con retención automática
 * (`defaultJobOptions.removeOnComplete/removeOnFail`), pero eso solo aplica a los jobs
 * NUEVOS. Este script es la pasada ÚNICA que barre lo ya acumulado en Redis desde antes.
 *
 * QUÉ BORRA — y qué NO:
 *   ✔ completed  terminados hace más de 24 h  (--older-than)
 *   ✔ failed     terminados hace más de 168 h = 7 días  (--older-than-failed)
 *   ✘ waiting / active / delayed / paused / prioritized: NO SE TOCAN NUNCA. Ahí viven
 *     los mensajes por enviar, los turnos de IA en vuelo, los recordatorios agendados y
 *     los escalamientos de WhatsApp con retraso. Borrar eso sería perder trabajo real.
 *
 * DRY-RUN POR DEFECTO: sin `--confirm` solo INFORMA (cuántos jobs viejos hay por cola y
 * cuánta memoria liberarían). En ese modo el script es de SOLO LECTURA: no abre colas
 * BullMQ ni escribe una sola clave en Redis.
 *
 * USO
 *   # 1) Ver qué habría que limpiar (no borra nada)
 *   REDIS_URL=redis://localhost:6379 node tools/ops/clean-queues.mjs
 *
 *   # 2) Limpiar de verdad (después de mirar el informe del paso 1)
 *   REDIS_URL=redis://localhost:6379 node tools/ops/clean-queues.mjs --confirm
 *
 *   # PROD (Railway) — SIEMPRE el dry-run primero:
 *   railway run -s Redis -- bash -c 'REDIS_URL="$REDIS_PUBLIC_URL" node tools/ops/clean-queues.mjs'
 *   railway run -s Redis -- bash -c 'REDIS_URL="$REDIS_PUBLIC_URL" node tools/ops/clean-queues.mjs --confirm'
 *
 * OPCIONES
 *   --confirm                  limpia de verdad (sin esto: dry-run)
 *   --older-than=<horas>       umbral de ANTIGÜEDAD. Default 24 para completed y 168 para
 *                              failed. OJO: si lo pasás, manda para AMBOS; para distinguir
 *                              usá también --older-than-failed.
 *   --older-than-failed=<horas>  umbral solo para los fallidos (gana sobre --older-than).
 *   --queue=<a,b,c>            limita a esas colas (nombres de la columna "cola").
 *   --no-size                  salta la estimación de memoria (una pasada menos a Redis).
 *
 * Mínimo 1 hora en los umbrales: el script se niega a borrar jobs recién terminados.
 * Node >=18, ESM, sin dependencias nuevas (ioredis / bullmq ya están en el repo; pnpm no
 * los hoistea a tools/, así que se resuelven desde apps/worker).
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Prefijo de claves de BullMQ. Las colas se crean sin `prefix`, así que es el default. */
const PREFIX = "bull";
/** Jobs por pasada de `clean`: en lotes para no bloquear Redis en un solo Lua gigante. */
const CLEAN_BATCH = 1000;
/** Jobs muestreados por cola para estimar la memoria (MEMORY USAGE es por clave). */
const SIZE_SAMPLE = 100;

/** Espejo de QUEUE_NAMES (packages/types/src/index.ts) — por si alguna cola aún no existe
 *  en Redis. A esto se le suman las colas DESCUBIERTAS, así que una cola nueva que alguien
 *  agregue sin actualizar esta lista igual aparece en el informe. */
const KNOWN_QUEUES = [
  "inbound-messages",
  "outbound-messages",
  "orchestrate",
  "workflow-steps",
  "platform-events",
  "webhook-deliveries",
  "capi-events",
  "contact-imports",
  "tenant-emails",
  "integration-sync",
  "notifications",
  "whatsapp-escalation",
  "agent-turn",
  "message-imports",
  "broadcast-send",
];

// ───────────────────────────── argumentos ─────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

const CONFIRM = flag("--confirm");
const WITH_SIZE = !flag("--no-size");

function hours(raw, fallback, label) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`✖ ${label}: "${raw}" no sirve. Tiene que ser un número de horas >= 1.`);
    process.exit(1);
  }
  return n;
}
const olderThanRaw = option("--older-than");
const HOURS_COMPLETED = hours(olderThanRaw, 24, "--older-than");
const HOURS_FAILED = hours(option("--older-than-failed") ?? olderThanRaw, 168, "--older-than-failed");

const onlyQueues = (option("--queue") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const unknownFlags = args.filter(
  (a) => a.startsWith("-") && !/^--(confirm|no-size|older-than|older-than-failed|queue)(=|$)/.test(a),
);
if (unknownFlags.length) {
  console.error(`✖ Opción desconocida: ${unknownFlags.join(", ")}. Mirá la cabecera del script.`);
  process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("✖ Falta REDIS_URL en el entorno. Ej: REDIS_URL=redis://localhost:6379 node tools/ops/clean-queues.mjs");
  process.exit(1);
}

// ───────────────────────── carga de dependencias ──────────────────────
/** pnpm no hoistea bullmq/ioredis a la raíz: se resuelven desde apps/worker (o apps/api). */
function resolveDep(name) {
  for (const pkg of ["apps/worker/package.json", "apps/api/package.json"]) {
    try {
      return createRequire(join(ROOT, pkg)).resolve(name);
    } catch {
      /* probamos el siguiente */
    }
  }
  return name; // último recurso: resolución normal (por si están hoisteadas)
}
async function load(name) {
  const resolved = resolveDep(name);
  return import(isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved);
}

const IORedis = (await load("ioredis")).default;

// ─────────────────────────────── helpers ──────────────────────────────
const key = (queue, suffix) => `${PREFIX}:${queue}:${suffix}`;

function mb(bytes) {
  if (bytes === null) return "n/d";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pad(text, width, right = false) {
  const s = String(text);
  return right ? s.padStart(width) : s.padEnd(width);
}

/** Descubre colas por sus claves `bull:<cola>:meta` (SCAN, sin KEYS: no bloquea Redis). */
async function discoverQueues(redis) {
  const found = new Set();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*:meta`, "COUNT", 500);
    cursor = next;
    for (const k of keys) {
      const name = k.slice(PREFIX.length + 1, k.length - ":meta".length);
      if (name && !name.includes(":")) found.add(name);
    }
  } while (cursor !== "0");
  return found;
}

/**
 * Jobs viejos de un conjunto terminado. `completed`/`failed` son ZSETs puntuados con el
 * timestamp en que el job terminó — el MISMO criterio que usa `queue.clean()` —, así que
 * ZCOUNT da el número EXACTO que se borraría, sin leer los jobs.
 */
async function countOld(redis, queue, set, cutoffMs) {
  const [total, old] = await Promise.all([
    redis.zcard(key(queue, set)),
    redis.zcount(key(queue, set), "-inf", cutoffMs),
  ]);
  return { total, old };
}

/** Estimación de memoria: MEMORY USAGE sobre una muestra de los jobs viejos × cantidad. */
async function estimateBytes(redis, queue, set, cutoffMs, oldCount) {
  if (!WITH_SIZE) return { bytes: 0, sampled: false }; // --no-size: no se informa memoria
  if (oldCount === 0) return { bytes: 0, sampled: false };
  let ids;
  try {
    ids = await redis.zrangebyscore(key(queue, set), "-inf", cutoffMs, "LIMIT", 0, SIZE_SAMPLE);
  } catch {
    return { bytes: null, sampled: false };
  }
  if (!ids.length) return { bytes: 0, sampled: false };

  const pipe = redis.pipeline();
  for (const id of ids) pipe.memory("USAGE", key(queue, id));
  let results;
  try {
    results = await pipe.exec();
  } catch {
    return { bytes: null, sampled: false }; // MEMORY USAGE deshabilitado en el proveedor
  }
  const sizes = (results ?? [])
    .map(([err, value]) => (err ? null : Number(value)))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!sizes.length) return { bytes: null, sampled: false };

  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return { bytes: Math.round(avg * oldCount), sampled: oldCount > sizes.length };
}

/** Borra en lotes hasta agotar. Solo `completed`/`failed`: nunca wait/active/delayed. */
async function cleanSet(queue, graceMs, set) {
  let removed = 0;
  for (;;) {
    const ids = await queue.clean(graceMs, CLEAN_BATCH, set);
    removed += ids.length;
    if (ids.length < CLEAN_BATCH) return removed;
  }
}

// ──────────────────────────────── main ────────────────────────────────
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

async function main() {
  const now = Date.now();
  const cutoff = {
    completed: now - HOURS_COMPLETED * 3_600_000,
    failed: now - HOURS_FAILED * 3_600_000,
  };

  console.log(`\n${CONFIRM ? "⚠ LIMPIEZA REAL" : "DRY-RUN (no se borra nada)"} — colas BullMQ en Redis`);
  console.log(`  Umbrales: completed > ${HOURS_COMPLETED} h   |   failed > ${HOURS_FAILED} h`);
  console.log(`  Corte:    completed antes de ${new Date(cutoff.completed).toISOString()}`);
  console.log(`            failed    antes de ${new Date(cutoff.failed).toISOString()}`);
  console.log("  Intactos: waiting / active / delayed / paused (trabajo pendiente o agendado)\n");

  const discovered = await discoverQueues(redis);
  let names = [...new Set([...discovered, ...KNOWN_QUEUES])].sort();
  if (onlyQueues.length) {
    const missing = onlyQueues.filter((q) => !names.includes(q));
    if (missing.length) console.log(`  (aviso) cola sin datos en este Redis: ${missing.join(", ")}\n`);
    names = names.filter((q) => onlyQueues.includes(q));
  }

  const W = [24, 10, 10, 10, 10, 9, 9, 9];
  console.log(
    [
      pad("cola", W[0]),
      pad("compl.", W[1], true),
      pad("→ viejos", W[2], true),
      pad("fallidos", W[3], true),
      pad("→ viejos", W[4], true),
      pad("esperan", W[5], true),
      pad("activos", W[6], true),
      pad("agendad.", W[7], true),
    ].join(" "),
  );
  console.log("─".repeat(W.reduce((a, b) => a + b + 1, 0)));

  const rows = [];
  let totalOld = 0;
  let totalBytes = 0;
  let bytesUnknown = false;

  for (const name of names) {
    const [completed, failed, waiting, active, delayed, paused] = await Promise.all([
      countOld(redis, name, "completed", cutoff.completed),
      countOld(redis, name, "failed", cutoff.failed),
      redis.llen(key(name, "wait")),
      redis.llen(key(name, "active")),
      redis.zcard(key(name, "delayed")),
      redis.llen(key(name, "paused")),
    ]);

    const nothing =
      completed.total === 0 && failed.total === 0 && waiting === 0 && active === 0 && delayed === 0 && paused === 0;
    if (nothing) continue; // cola vacía/inexistente: no ensucia el informe

    const [sizeCompleted, sizeFailed] = await Promise.all([
      estimateBytes(redis, name, "completed", cutoff.completed, completed.old),
      estimateBytes(redis, name, "failed", cutoff.failed, failed.old),
    ]);
    const bytes =
      sizeCompleted.bytes === null || sizeFailed.bytes === null ? null : sizeCompleted.bytes + sizeFailed.bytes;
    if (bytes === null) bytesUnknown = true;
    else totalBytes += bytes;
    totalOld += completed.old + failed.old;

    rows.push({ name, completed, failed, waiting, active, delayed, paused, bytes });
    console.log(
      [
        pad(name, W[0]),
        pad(completed.total, W[1], true),
        pad(completed.old, W[2], true),
        pad(failed.total, W[3], true),
        pad(failed.old, W[4], true),
        pad(waiting + paused, W[5], true),
        pad(active, W[6], true),
        pad(delayed, W[7], true),
      ].join(" ") + (bytes ? `   ~${mb(bytes)} a liberar` : ""),
    );
  }

  if (!rows.length) {
    console.log("(ninguna cola con jobs en este Redis)");
    return;
  }

  console.log("");
  const sizeTxt = !WITH_SIZE
    ? "memoria no medida (--no-size)"
    : bytesUnknown
      ? `~${mb(totalBytes)} o más (estimación parcial: Redis no reportó algunos tamaños)`
      : `~${mb(totalBytes)} a liberar (estimado por muestreo)`;
  console.log(`TOTAL a limpiar: ${totalOld} jobs terminados viejos — ${sizeTxt}`);

  if (!CONFIRM) {
    console.log("\nDRY-RUN: no se borró nada. Para limpiar de verdad, repetí el comando con --confirm.");
    return;
  }
  if (totalOld === 0) {
    console.log("\nNada que borrar: no hay jobs terminados más viejos que los umbrales.");
    return;
  }

  // Limpieza real: una Queue por nombre, y solo los conjuntos terminados.
  const { Queue } = await load("bullmq");
  console.log("\nLimpiando…");
  let removedTotal = 0;
  for (const row of rows) {
    if (row.completed.old === 0 && row.failed.old === 0) continue;
    const queue = new Queue(row.name, { connection: redis });
    try {
      const removedCompleted = row.completed.old ? await cleanSet(queue, HOURS_COMPLETED * 3_600_000, "completed") : 0;
      const removedFailed = row.failed.old ? await cleanSet(queue, HOURS_FAILED * 3_600_000, "failed") : 0;
      removedTotal += removedCompleted + removedFailed;
      console.log(`  ✔ ${pad(row.name, 24)} ${removedCompleted} completados + ${removedFailed} fallidos borrados`);
    } catch (err) {
      console.error(`  ✖ ${pad(row.name, 24)} ${err.message}`);
    } finally {
      await queue.close();
    }
  }
  console.log(`\nListo: ${removedTotal} jobs borrados. waiting/active/delayed quedaron intactos.`);
}

main()
  .catch((err) => {
    console.error("✖ Falló la limpieza:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.quit().catch(() => redis.disconnect());
  });
