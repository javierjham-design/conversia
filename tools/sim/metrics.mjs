#!/usr/bin/env node
/**
 * METRICS — Muestreador de observabilidad para la prueba de CARGA MASIVA.
 *
 * Trabaja SIEMPRE contra el stack AISLADO de la simulación (BD/Redis propios +
 * providers mock). JAMÁS debe apuntar a producción.
 *
 * Dos modos:
 *   1) `node tools/sim/metrics.mjs`          → muestrea cada SIM_METRICS_INTERVAL_MS (10s
 *                                               por defecto) hasta Ctrl-C (SIGINT); escribe
 *                                               el CSV en vivo y, al salir, imprime + guarda
 *                                               un resumen JSON (percentiles de latencia,
 *                                               pérdidas, invariantes de dinero).
 *   2) `node tools/sim/metrics.mjs summary`  → NO muestrea; solo calcula el resumen de cierre
 *                                               sobre la tabla `messages` + chequeo de pérdidas
 *                                               (contra un sent-log del harness CARGA si existe)
 *                                               + hint de invariantes de dinero. Si hay un
 *                                               metrics-*.csv previo en out/, también resume
 *                                               profundidad máxima de colas / conexiones / RSS.
 *
 * Fuentes de métrica (cada una envuelta en try/catch: si una cae —p.ej. Redis— el resto sigue):
 *   - Colas BullMQ (Redis vía ioredis, REDIS_URL): LLEN wait/active, ZCARD delayed/failed,
 *     SCARD stalled para `inbound-messages`, `outbound-messages` y `agent-turn`.
 *   - Postgres (psql CLI sobre DIRECT_DATABASE_URL admin, o flags SIM_PG_*): pg_stat_activity
 *     por estado + locks en espera; pg_stat_database xact_commit/rollback (se reporta el DELTA
 *     por muestra).
 *   - Procesos: RSS (MB) de los node de api y worker (Windows: Get-CimInstance Win32_Process;
 *     match por línea de comando o por PID-file si el launcher lo escribe).
 *
 * Nota de dependencias: el repo NO tiene instalado el paquete `pg` (solo @prisma/client,
 * ioredis y bullmq). Para Postgres usamos el binario `psql` con la URL admin —igual que
 * `sim250.mjs`—, lo que da visibilidad admin real sin agregar dependencias.
 */

import {
  appendFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";

// ───────────────────────────── Config por env ─────────────────────────────
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // …/tools/sim
const REPO_ROOT = resolve(SCRIPT_DIR, "..", ".."); // raíz del monorepo

const MODE = (process.argv[2] ?? "sample").toLowerCase(); // "summary" o muestreo por defecto
const INTERVAL_MS = Number(process.env.SIM_METRICS_INTERVAL_MS ?? 10000);
const OUT_DIR = process.env.SIM_OUT ?? join(SCRIPT_DIR, "out");
const PSQL = process.env.SIM_PSQL ?? "psql";
const BULL_PREFIX = process.env.SIM_BULL_PREFIX ?? "bull";
// Redis: REDIS_URL es el canónico; SIM_REDIS_URL permite forzar el del stack sim.
const REDIS_URL = process.env.SIM_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";

mkdirSync(OUT_DIR, { recursive: true });
const OUT = (p) => join(OUT_DIR, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
// Timestamp apto para nombre de archivo en Windows (sin ':' ni '.').
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ──────────────────────── Conexión Postgres (psql CLI) ────────────────────────
// Preferencia: DIRECT_DATABASE_URL (admin) → se parsea a flags -h/-p/-U/-d + PGPASSWORD.
// Fallback: flags SIM_PG_* idénticos a sim250.mjs (host/port/user/db/password).
function resolvePgTarget() {
  const url = process.env.SIM_DIRECT_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || "localhost",
        port: u.port || "5432",
        user: decodeURIComponent(u.username || "postgres"),
        password: decodeURIComponent(u.password || ""),
        db: (u.pathname || "/postgres").replace(/^\//, "") || "postgres",
        source: "DIRECT_DATABASE_URL",
      };
    } catch {
      /* URL inválida → caemos a los flags SIM_PG_* */
    }
  }
  return {
    host: process.env.SIM_PG_HOST ?? "localhost",
    port: process.env.SIM_PG_PORT ?? "5433",
    user: process.env.SIM_PG_USER ?? "postgres",
    password: process.env.SIM_PG_PASSWORD ?? "postgres",
    db: process.env.SIM_PG_DB ?? "conversia_sim",
    source: "SIM_PG_*",
  };
}
const PG = resolvePgTarget();

// Ejecuta una consulta y devuelve texto crudo (tab-separado, sin encabezados).
// Usa -F '\t' (tab real): seguro para salidas numéricas y to_char con espacios.
function psqlRaw(sql) {
  return execFileSync(
    PSQL,
    ["-h", PG.host, "-p", String(PG.port), "-U", PG.user, "-d", PG.db, "-X", "-q", "-t", "-A", "-F", "\t", "-c", sql],
    { env: { ...process.env, PGPASSWORD: PG.password }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).replace(/\s+$/g, "");
}
// Devuelve filas → arreglo de arreglos de celdas (string).
function psqlRows(sql) {
  const out = psqlRaw(sql);
  if (!out) return [];
  return out.split("\n").map((line) => line.split("\t"));
}
// Primera fila (una sola esperada).
function psqlRow(sql) {
  const rows = psqlRows(sql);
  return rows[0] ?? [];
}
const num = (v) => {
  if (v === "" || v === null || v === undefined) return null; // celda psql vacía = SQL NULL
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─────────────────────── Conexión Redis (ioredis resuelto del worker) ───────────────────────
// En el monorepo pnpm ioredis NO está hoisteado a la raíz: lo resolvemos desde
// apps/worker (que lo declara como dependencia) y lo importamos por ruta de archivo.
let redis = null;
async function openRedis() {
  try {
    const req = createRequire(join(REPO_ROOT, "apps", "worker", "package.json"));
    const resolved = req.resolve("ioredis");
    const IORedis = (await import(pathToFileURL(resolved).href)).default;
    redis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 4000,
      lazyConnect: false,
      retryStrategy: () => null, // no reintentos infinitos: fallar rápido para no bloquear la muestra
    });
    redis.on("error", () => {}); // silenciamos: cada muestra ya maneja su error
    return true;
  } catch (e) {
    console.error(`  [warn] no pude cargar ioredis: ${String(e.message).slice(0, 120)} — métricas de cola deshabilitadas`);
    return false;
  }
}

// Comando Redis por tipo de estructura de la cola BullMQ.
const QUEUE_CMD = {
  wait: "llen", // LIST
  active: "llen", // LIST
  paused: "llen", // LIST
  delayed: "zcard", // ZSET
  failed: "zcard", // ZSET
  completed: "zcard", // ZSET
  prioritized: "zcard", // ZSET (BullMQ moderno)
  stalled: "scard", // SET
};
// Qué cola y qué sub-claves emitimos. inbound/outbound = set completo; agent-turn = ligero.
const QUEUES = [
  { name: "inbound-messages", key: "inbound", subs: ["wait", "active", "delayed", "failed", "stalled"] },
  { name: "outbound-messages", key: "outbound", subs: ["wait", "active", "delayed", "failed", "stalled"] },
  { name: "agent-turn", key: "agentturn", subs: ["wait", "active"] },
];

async function sampleQueues() {
  if (!redis) return { err: "redis-unavailable", values: {} };
  try {
    const pipe = redis.pipeline();
    const plan = [];
    for (const q of QUEUES) {
      for (const sub of q.subs) {
        const cmd = QUEUE_CMD[sub];
        const redisKey = `${BULL_PREFIX}:${q.name}:${sub}`;
        pipe[cmd](redisKey);
        plan.push(`${q.key}_${sub}`);
      }
    }
    const res = await pipe.exec(); // [[err, val], ...]
    const values = {};
    res.forEach(([err, val], i) => {
      values[plan[i]] = err ? null : num(val);
    });
    return { err: "", values };
  } catch (e) {
    return { err: String(e.message).slice(0, 80), values: {} };
  }
}

// ─────────────────────── Muestra de Postgres ───────────────────────
// Devuelve conexiones por estado + locks en espera + xact acumulados (el delta se calcula fuera).
function samplePostgres() {
  try {
    const row = psqlRow(`SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active')::bigint,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle')::bigint,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction')::bigint,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction (aborted)')::bigint,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())::bigint,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock')::bigint,
      (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
      (SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()),
      (SELECT xact_rollback FROM pg_stat_database WHERE datname=current_database());`);
    return {
      err: "",
      active: num(row[0]),
      idle: num(row[1]),
      idle_in_txn: num(row[2]),
      idle_in_txn_aborted: num(row[3]),
      total: num(row[4]),
      waiting_locks: num(row[5]),
      max_conn: num(row[6]),
      xact_commit: num(row[7]),
      xact_rollback: num(row[8]),
    };
  } catch (e) {
    return { err: String(e.stderr || e.message).slice(0, 80) };
  }
}

// ─────────────────────── Muestra de procesos (RSS) ───────────────────────
// Clasifica los node por api / worker usando la línea de comando o un PID-file opcional.
const API_RE = process.env.SIM_PROC_API_MATCH
  ? new RegExp(process.env.SIM_PROC_API_MATCH, "i")
  : /apps[\\/]api|api[\\/](src|dist)[\\/]main|ts-node[\\/]register[\\/]transpile-only/i;
const WORKER_RE = process.env.SIM_PROC_WORKER_MATCH
  ? new RegExp(process.env.SIM_PROC_WORKER_MATCH, "i")
  : /apps[\\/]worker|worker[\\/](src|dist)[\\/]main/i;

function pidFromFile(envVar) {
  const f = process.env[envVar];
  if (!f || !existsSync(f)) return null;
  try {
    const n = parseInt(readFileSync(f, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function listNodeProcs() {
  // Devuelve [{pid, rssMb, cmd}] de todos los procesos node.
  if (process.platform === "win32") {
    const ps = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    if (!ps) return [];
    let parsed = JSON.parse(ps);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed.map((p) => ({
      pid: Number(p.ProcessId),
      rssMb: Number(p.WorkingSetSize) / (1024 * 1024),
      cmd: String(p.CommandLine ?? ""),
    }));
  }
  // POSIX (fallback): ps -eo pid=,rss=,args= y filtramos node.
  const out = execFileSync("ps", ["-eo", "pid=,rss=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3];
    if (!/node/i.test(cmd)) continue;
    procs.push({ pid: Number(m[1]), rssMb: Number(m[2]) / 1024, cmd }); // ps rss viene en KB
  }
  return procs;
}

function sampleProcs() {
  try {
    const procs = listNodeProcs();
    const apiPid = pidFromFile("SIM_API_PID_FILE");
    const workerPid = pidFromFile("SIM_WORKER_PID_FILE");
    let apiRss = 0,
      workerRss = 0,
      otherRss = 0,
      apiHit = false,
      workerHit = false,
      nodeCount = 0;
    for (const p of procs) {
      if (p.pid === process.pid) continue; // no contamos al propio muestreador
      nodeCount++;
      const isApi = apiPid ? p.pid === apiPid : API_RE.test(p.cmd);
      const isWorker = workerPid ? p.pid === workerPid : WORKER_RE.test(p.cmd);
      if (isApi) {
        apiRss += p.rssMb;
        apiHit = true;
      } else if (isWorker) {
        workerRss += p.rssMb;
        workerHit = true;
      } else {
        otherRss += p.rssMb;
      }
    }
    return {
      err: "",
      api_rss_mb: apiHit ? apiRss : null,
      worker_rss_mb: workerHit ? workerRss : null,
      other_node_rss_mb: otherRss,
      node_count: nodeCount,
    };
  } catch (e) {
    return { err: String(e.message).slice(0, 80) };
  }
}

// ─────────────────────── CSV ───────────────────────
// Columnas en orden fijo. Mantener header y fila sincronizados vía esta lista.
const COLUMNS = [
  "timestamp_iso",
  "elapsed_s",
  // colas
  "q_inbound_wait",
  "q_inbound_active",
  "q_inbound_delayed",
  "q_inbound_failed",
  "q_inbound_stalled",
  "q_outbound_wait",
  "q_outbound_active",
  "q_outbound_delayed",
  "q_outbound_failed",
  "q_outbound_stalled",
  "q_agentturn_wait",
  "q_agentturn_active",
  // postgres
  "pg_active",
  "pg_idle",
  "pg_idle_in_txn",
  "pg_idle_in_txn_aborted",
  "pg_total",
  "pg_max_conn",
  "pg_waiting_locks",
  "pg_xact_commit_delta",
  "pg_xact_rollback_delta",
  // procesos
  "proc_api_rss_mb",
  "proc_worker_rss_mb",
  "proc_other_node_rss_mb",
  "proc_node_count",
  // errores por fuente (vacío = ok)
  "redis_err",
  "pg_err",
  "proc_err",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  const s = String(v);
  return /[",\n\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(obj) {
  return COLUMNS.map((c) => csvCell(obj[c])).join(",");
}

// ─────────────────────── Modo muestreo (default) ───────────────────────
const rawSamples = []; // se guardan para el resumen de cierre
let prevXactCommit = null;
let prevXactRollback = null;

function buildSample(t0) {
  return (async () => {
    const q = await sampleQueues();
    const pg = samplePostgres();
    const proc = sampleProcs();

    // delta de transacciones (acumulado → por-muestra)
    let commitDelta = null,
      rollbackDelta = null;
    if (pg.xact_commit != null) {
      commitDelta = prevXactCommit == null ? null : pg.xact_commit - prevXactCommit;
      prevXactCommit = pg.xact_commit;
    }
    if (pg.xact_rollback != null) {
      rollbackDelta = prevXactRollback == null ? null : pg.xact_rollback - prevXactRollback;
      prevXactRollback = pg.xact_rollback;
    }

    const row = {
      timestamp_iso: nowIso(),
      elapsed_s: Math.round((Date.now() - t0) / 1000),
      q_inbound_wait: q.values.inbound_wait,
      q_inbound_active: q.values.inbound_active,
      q_inbound_delayed: q.values.inbound_delayed,
      q_inbound_failed: q.values.inbound_failed,
      q_inbound_stalled: q.values.inbound_stalled,
      q_outbound_wait: q.values.outbound_wait,
      q_outbound_active: q.values.outbound_active,
      q_outbound_delayed: q.values.outbound_delayed,
      q_outbound_failed: q.values.outbound_failed,
      q_outbound_stalled: q.values.outbound_stalled,
      q_agentturn_wait: q.values.agentturn_wait,
      q_agentturn_active: q.values.agentturn_active,
      pg_active: pg.active,
      pg_idle: pg.idle,
      pg_idle_in_txn: pg.idle_in_txn,
      pg_idle_in_txn_aborted: pg.idle_in_txn_aborted,
      pg_total: pg.total,
      pg_max_conn: pg.max_conn,
      pg_waiting_locks: pg.waiting_locks,
      pg_xact_commit_delta: commitDelta,
      pg_xact_rollback_delta: rollbackDelta,
      proc_api_rss_mb: proc.api_rss_mb,
      proc_worker_rss_mb: proc.worker_rss_mb,
      proc_other_node_rss_mb: proc.other_node_rss_mb,
      proc_node_count: proc.node_count,
      redis_err: q.err,
      pg_err: pg.err,
      proc_err: proc.err,
    };
    return row;
  })();
}

function maskUrl(u) {
  try {
    const url = new URL(u);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return u;
  }
}

async function runSampler() {
  const stamp = fileStamp();
  const csvPath = OUT(`metrics-${stamp}.csv`);
  const summaryPath = OUT(`summary-${stamp}.json`);
  writeFileSync(csvPath, COLUMNS.join(",") + "\n");

  console.log("────────────────────────────────────────────────────────────");
  console.log("  OBSERVABILIDAD · muestreo de CARGA MASIVA");
  console.log(`  intervalo   : ${INTERVAL_MS} ms`);
  console.log(`  redis       : ${maskUrl(REDIS_URL)}  (prefijo BullMQ: ${BULL_PREFIX})`);
  console.log(`  postgres    : ${PG.user}@${PG.host}:${PG.port}/${PG.db}  (origen: ${PG.source})`);
  console.log(`  colas       : ${QUEUES.map((q) => q.name).join(", ")}`);
  console.log(`  csv         : ${csvPath}`);
  console.log(`  summary     : ${summaryPath}  (al salir con Ctrl-C)`);
  console.log("  Ctrl-C para detener y calcular el resumen de cierre.");
  console.log("────────────────────────────────────────────────────────────");

  await openRedis();

  const t0 = Date.now();
  let running = true;
  let inFlight = Promise.resolve();
  let timer = null;
  let finalized = false;

  const tick = async () => {
    if (!running) return;
    inFlight = buildSample(t0);
    const row = await inFlight;
    rawSamples.push(row);
    appendFileSync(csvPath, csvLine(row) + "\n");
    // Línea de progreso compacta en consola.
    console.log(
      `  t+${String(row.elapsed_s).padStart(4)}s  inbound.wait=${row.q_inbound_wait ?? "-"} outbound.wait=${row.q_outbound_wait ?? "-"}` +
        ` pg.active=${row.pg_active ?? "-"}/${row.pg_total ?? "-"} locks=${row.pg_waiting_locks ?? "-"}` +
        ` rss(api/wrk)=${row.proc_api_rss_mb != null ? row.proc_api_rss_mb.toFixed(0) : "-"}/${row.proc_worker_rss_mb != null ? row.proc_worker_rss_mb.toFixed(0) : "-"}MB` +
        (row.redis_err ? ` [redis:${row.redis_err}]` : "") +
        (row.pg_err ? ` [pg:${row.pg_err}]` : ""),
    );
    if (running) timer = setTimeout(tick, INTERVAL_MS);
  };

  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    running = false;
    if (timer) clearTimeout(timer);
    try {
      await inFlight;
    } catch {
      /* ignore */
    }
    console.log(`\n  Detenido. ${rawSamples.length} muestras. Calculando resumen de cierre…`);
    const summary = await computeSummary({ csvRollupFrom: rawSamples });
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    printSummary(summary);
    console.log(`\n  CSV     : ${csvPath}`);
    console.log(`  Summary : ${summaryPath}`);
    try {
      if (redis) await redis.quit();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", finalize);
  process.on("SIGTERM", finalize);
  await tick();
}

// ─────────────────────── Resumen de cierre (latencia / pérdidas / dinero) ───────────────────────

// Cláusula WHERE de ventana temporal (sobre i.created_at) para fases.
function windowClause(startIso, endIso) {
  const parts = [];
  if (startIso) parts.push(`AND i.created_at >= '${startIso}'`);
  if (endIso) parts.push(`AND i.created_at < '${endIso}'`);
  return parts.join(" ");
}

// Percentiles de latencia inbound→outbound. grouped=true → por minuto; false → global.
function latencyQuery({ startIso, endIso, grouped }) {
  const win = windowClause(startIso, endIso);
  const bucket = grouped ? "to_char(date_trunc('minute', i.created_at),'YYYY-MM-DD HH24:MI')" : "'(global)'";
  // Siempre agrupamos por el bucket: en modo global es una constante → una sola fila
  // (sin GROUP BY, Postgres rechaza seleccionar la columna `bucket` junto a agregados).
  const groupBy = grouped ? "GROUP BY 1 ORDER BY 1" : "GROUP BY 1";
  const sql = `
    WITH pairs AS (
      SELECT ${bucket} AS bucket,
             EXTRACT(EPOCH FROM (nx.oc - i.created_at)) * 1000.0 AS ms
      FROM messages i
      CROSS JOIN LATERAL (
        SELECT ob.created_at AS oc
        FROM messages ob
        WHERE ob.conversation_id = i.conversation_id
          AND ob.direction = 'OUTBOUND'
          AND ob.created_at > i.created_at
        ORDER BY ob.created_at ASC
        LIMIT 1
      ) nx
      WHERE i.direction = 'INBOUND' ${win}
    )
    SELECT bucket,
      count(*) AS n,
      round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms))::bigint AS p50,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::bigint AS p95,
      round(percentile_cont(0.99) WITHIN GROUP (ORDER BY ms))::bigint AS p99,
      round(max(ms))::bigint AS maxms
    FROM pairs ${groupBy};`;
  const rows = psqlRows(sql);
  return rows
    .filter((r) => r.length >= 6)
    .map((r) => ({ bucket: r[0], n: num(r[1]), p50: num(r[2]), p95: num(r[3]), p99: num(r[4]), max: num(r[5]) }));
}

// Chequeo de pérdidas y dedupe de wamid sobre la tabla messages.
function lossQuery() {
  const row = psqlRow(`SELECT
    (SELECT count(*) FROM messages WHERE direction='INBOUND'),
    (SELECT count(*) FROM messages WHERE direction='INBOUND' AND external_id IS NOT NULL),
    (SELECT count(DISTINCT external_id) FROM messages WHERE direction='INBOUND' AND external_id IS NOT NULL),
    (SELECT count(*) FROM messages WHERE direction='INBOUND' AND external_id IS NULL),
    (SELECT count(*) FROM (SELECT organization_id, external_id FROM messages WHERE direction='INBOUND' AND external_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) t),
    (SELECT count(*) FROM messages WHERE direction='OUTBOUND'),
    (SELECT count(*) FROM messages WHERE direction='OUTBOUND' AND status='FAILED');`);
  return {
    inbound_total: num(row[0]),
    inbound_with_wamid: num(row[1]),
    inbound_distinct_wamid: num(row[2]),
    inbound_null_wamid: num(row[3]),
    inbound_duplicate_wamid_groups: num(row[4]),
    outbound_total: num(row[5]),
    outbound_failed: num(row[6]),
  };
}

function outboundFailuresByCause() {
  const rows = psqlRows(
    `SELECT coalesce(nullif(error,''),'(sin error)') AS cause, count(*)
     FROM messages WHERE direction='OUTBOUND' AND status='FAILED'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 20;`,
  );
  return rows.filter((r) => r.length >= 2).map((r) => ({ cause: r[0], count: num(r[1]) }));
}

// Hint de invariantes de dinero sobre conversation_credit_ledger.
function moneyQuery() {
  const row = psqlRow(`SELECT
    (SELECT count(*) FROM conversation_credit_ledger WHERE reason='conversation_debit'),
    (SELECT count(*) FROM conversation_credit_ledger WHERE reason='conversation_debit' AND delta >= 0),
    (SELECT count(DISTINCT organization_id) FROM conversation_credit_ledger WHERE reason='conversation_debit'),
    (SELECT count(*) FROM (SELECT conversation_id FROM conversation_credit_ledger WHERE reason='conversation_debit' AND conversation_id IS NOT NULL GROUP BY conversation_id HAVING count(*) > 1) t),
    (SELECT count(*) FROM conversation_credit_ledger WHERE reason='conversation_debit' AND conversation_id IS NULL);`);
  return {
    debits_total: num(row[0]),
    debits_non_negative_anomaly: num(row[1]), // un débito debería ser delta<0
    orgs_with_debits: num(row[2]),
    conversations_debited_more_than_once: num(row[3]), // DEBE ser 0 (sin débitos duplicados)
    debits_without_conversation_id: num(row[4]),
  };
}

// ─────────────────────── Lectura flexible de artefactos del harness CARGA ───────────────────────
function findLatest(regex) {
  try {
    const files = readdirSync(OUT_DIR)
      .filter((f) => regex.test(f))
      .map((f) => ({ f, m: statSync(OUT(f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? OUT(files[0].f) : null;
  } catch {
    return null;
  }
}

// Marcador de fases: archivo JSON phases*.json (o w8-phases*.json). Formato flexible:
//   [{ name|phase|label, start|startMs|startedAt|from, end|endMs|endedAt|to }]  (ISO o epoch)
// o { phases: [...] }. Devuelve [{ name, startIso, endIso }] o [].
function loadPhases() {
  const path = findLatest(/(^|[-_])phases?.*\.json$/i) ?? (existsSync(OUT("w8-phases.json")) ? OUT("w8-phases.json") : null);
  if (!path) return { path: null, phases: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.phases) ? parsed.phases : [];
    const toIso = (v) => {
      if (v == null) return null;
      if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
      const n = Number(v);
      if (Number.isFinite(n) && String(v).trim() !== "" && !/[-:TZ]/.test(String(v)))
        return new Date(n > 1e12 ? n : n * 1000).toISOString();
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };
    const phases = arr
      .map((p) => ({
        name: p.name ?? p.phase ?? p.label ?? "fase",
        startIso: toIso(p.start ?? p.startMs ?? p.startedAt ?? p.from ?? p.start_at),
        endIso: toIso(p.end ?? p.endMs ?? p.endedAt ?? p.to ?? p.end_at),
      }))
      .filter((p) => p.startIso || p.endIso);
    return { path, phases };
  } catch (e) {
    return { path, phases: [], error: String(e.message).slice(0, 120) };
  }
}

// Sent-log del harness CARGA (para el chequeo de pérdidas 1:1 por wamid). Formato flexible:
//   - JSON: arreglo de strings (wamids) | arreglo de objetos {wamid|externalId|id} | {count} | {sent:[...]}
//   - CSV : columna wamid|external_id|externalId|id (o 1ª columna) por fila.
// Devuelve { path, wamids:Set|null, count:number|null }.
function loadSentLog() {
  const path = findLatest(/(^|[-_])sent.*\.(json|csv|ndjson|log)$/i);
  if (!path) return { path: null, wamids: null, count: null };
  try {
    const text = readFileSync(path, "utf8");
    const ext = path.toLowerCase();
    if (ext.endsWith(".json")) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const set = new Set(parsed.map((x) => (typeof x === "string" ? x : x?.wamid ?? x?.externalId ?? x?.id)).filter(Boolean));
        return { path, wamids: set, count: set.size };
      }
      if (Array.isArray(parsed?.sent)) {
        const set = new Set(parsed.sent.map((x) => (typeof x === "string" ? x : x?.wamid ?? x?.externalId ?? x?.id)).filter(Boolean));
        return { path, wamids: set, count: set.size };
      }
      if (typeof parsed?.count === "number") return { path, wamids: null, count: parsed.count };
      return { path, wamids: null, count: null };
    }
    // CSV / NDJSON / log: una entrada por línea.
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (!lines.length) return { path, wamids: new Set(), count: 0 };
    if (ext.endsWith(".ndjson") || ext.endsWith(".log")) {
      const set = new Set();
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          const id = typeof o === "string" ? o : o?.wamid ?? o?.externalId ?? o?.id;
          if (id) set.add(id);
        } catch {
          set.add(l.trim());
        }
      }
      return { path, wamids: set, count: set.size };
    }
    // CSV
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = header.findIndex((h) => ["wamid", "external_id", "externalid", "id"].includes(h));
    const hasHeader = idx >= 0;
    const col = hasHeader ? idx : 0;
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const set = new Set(dataLines.map((l) => l.split(",")[col]?.trim()).filter(Boolean));
    return { path, wamids: set, count: set.size };
  } catch (e) {
    return { path, wamids: null, count: null, error: String(e.message).slice(0, 120) };
  }
}

// Cruza el sent-log con los wamids almacenados en BD.
function reconcileSent(sent) {
  if (!sent.path) return { present: false, note: "sin sent-log; pérdidas = chequeo de dedupe sobre BD" };
  if (!sent.wamids) return { present: true, path: sent.path, sent_count: sent.count, note: "sent-log sin lista de wamids (solo conteo)" };
  // Traemos los wamids INBOUND distintos y hacemos la diferencia en JS.
  const stored = new Set();
  try {
    const rows = psqlRows(`SELECT DISTINCT external_id FROM messages WHERE direction='INBOUND' AND external_id IS NOT NULL;`);
    for (const r of rows) if (r[0]) stored.add(r[0]);
  } catch (e) {
    return { present: true, path: sent.path, sent_count: sent.count, error: String(e.message).slice(0, 120) };
  }
  const missing = []; // enviados pero NO en BD → pérdida
  for (const w of sent.wamids) if (!stored.has(w)) missing.push(w);
  const extra = []; // en BD pero NO en el sent-log → inesperado
  for (const w of stored) if (!sent.wamids.has(w)) extra.push(w);
  return {
    present: true,
    path: sent.path,
    sent_count: sent.wamids.size,
    stored_distinct: stored.size,
    missing_count: missing.length,
    extra_count: extra.length,
    missing_sample: missing.slice(0, 20),
    extra_sample: extra.slice(0, 20),
    loss_ok: missing.length === 0,
  };
}

// Resumen de las muestras del CSV (profundidad máx de colas, conexiones, crecimiento de RSS).
function rollupSamples(samples) {
  if (!samples.length) return null;
  const maxOf = (k) => samples.reduce((m, s) => (s[k] != null && s[k] > m ? s[k] : m), 0);
  const firstDef = (k) => samples.find((s) => s[k] != null)?.[k] ?? null;
  const lastDef = (k) => [...samples].reverse().find((s) => s[k] != null)?.[k] ?? null;
  const minOf = (k) => {
    const vals = samples.map((s) => s[k]).filter((v) => v != null);
    return vals.length ? Math.min(...vals) : null;
  };
  const rssGrowth = (k) => {
    const first = firstDef(k),
      last = lastDef(k);
    if (first == null || last == null || first === 0) return null;
    return +(((last - first) / first) * 100).toFixed(1); // % de crecimiento (soak: debería ser ±15%)
  };
  return {
    samples: samples.length,
    span_s: lastDef("elapsed_s"),
    queue_depth_max: {
      inbound_wait: maxOf("q_inbound_wait"),
      outbound_wait: maxOf("q_outbound_wait"),
      agentturn_wait: maxOf("q_agentturn_wait"),
      inbound_active: maxOf("q_inbound_active"),
      outbound_active: maxOf("q_outbound_active"),
    },
    queue_failed_max: { inbound: maxOf("q_inbound_failed"), outbound: maxOf("q_outbound_failed") },
    queue_stalled_max: { inbound: maxOf("q_inbound_stalled"), outbound: maxOf("q_outbound_stalled") },
    pg_connections_max: maxOf("pg_total"),
    pg_active_max: maxOf("pg_active"),
    pg_idle_in_txn_max: maxOf("pg_idle_in_txn"),
    pg_waiting_locks_max: maxOf("pg_waiting_locks"),
    pg_max_conn: lastDef("pg_max_conn"),
    rss_api_mb: { first: firstDef("proc_api_rss_mb"), min: minOf("proc_api_rss_mb"), max: maxOf("proc_api_rss_mb"), last: lastDef("proc_api_rss_mb"), growth_pct: rssGrowth("proc_api_rss_mb") },
    rss_worker_mb: { first: firstDef("proc_worker_rss_mb"), min: minOf("proc_worker_rss_mb"), max: maxOf("proc_worker_rss_mb"), last: lastDef("proc_worker_rss_mb"), growth_pct: rssGrowth("proc_worker_rss_mb") },
  };
}

// Divide una línea CSV respetando comillas (las columnas *_err pueden llevar comas).
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// Parser de un metrics-*.csv a objetos (para `summary` leyendo del disco).
function readCsvSamples(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const obj = {};
    header.forEach((h, i) => {
      const v = cells[i] ?? "";
      obj[h] = v === "" ? null : isNaN(Number(v)) ? v : Number(v);
    });
    return obj;
  });
}

// Orquesta el resumen completo. csvRollupFrom = muestras en memoria (SIGINT) o null (modo summary → lee disco).
async function computeSummary({ csvRollupFrom = null } = {}) {
  const summary = {
    generated_at: nowIso(),
    mode: csvRollupFrom ? "sigint" : "summary",
    pg_target: `${PG.user}@${PG.host}:${PG.port}/${PG.db} (${PG.source})`,
  };

  // Latencia (global + por minuto + por fase si hay marcador).
  try {
    summary.latency_overall = latencyQuery({ grouped: false })[0] ?? null;
    summary.latency_per_minute = latencyQuery({ grouped: true });
  } catch (e) {
    summary.latency_error = String(e.stderr || e.message).slice(0, 160);
  }

  const { path: phasesPath, phases } = loadPhases();
  summary.phases_file = phasesPath;
  if (phases.length) {
    summary.latency_per_phase = [];
    for (const ph of phases) {
      try {
        const overall = latencyQuery({ startIso: ph.startIso, endIso: ph.endIso, grouped: false })[0] ?? null;
        summary.latency_per_phase.push({ phase: ph.name, startIso: ph.startIso, endIso: ph.endIso, ...overall });
      } catch (e) {
        summary.latency_per_phase.push({ phase: ph.name, error: String(e.message).slice(0, 120) });
      }
    }
  }

  // Pérdidas + dedupe + outbound fallidos.
  try {
    summary.loss = lossQuery();
    summary.loss.inbound_dedup_ok = summary.loss.inbound_duplicate_wamid_groups === 0;
    summary.outbound_failures_by_cause = outboundFailuresByCause();
  } catch (e) {
    summary.loss_error = String(e.stderr || e.message).slice(0, 160);
  }

  // Reconciliación contra sent-log del harness CARGA (si existe).
  try {
    summary.sent_reconciliation = reconcileSent(loadSentLog());
  } catch (e) {
    summary.sent_reconciliation = { error: String(e.message).slice(0, 160) };
  }

  // Hint de invariantes de dinero.
  try {
    summary.money = moneyQuery();
    summary.money.no_duplicate_debits_ok = summary.money.conversations_debited_more_than_once === 0;
  } catch (e) {
    summary.money_error = String(e.stderr || e.message).slice(0, 160);
  }

  // Rollup de las muestras (memoria o CSV en disco).
  let samples = csvRollupFrom;
  if (!samples) {
    const csv = findLatest(/^metrics-.*\.csv$/i);
    summary.csv_file = csv;
    if (csv) {
      try {
        samples = readCsvSamples(csv);
      } catch (e) {
        summary.csv_error = String(e.message).slice(0, 120);
      }
    }
  }
  if (samples && samples.length) summary.samples_rollup = rollupSamples(samples);

  return summary;
}

function printSummary(s) {
  console.log("\n══════════════════ RESUMEN DE CIERRE ══════════════════");
  if (s.latency_overall) {
    const o = s.latency_overall;
    console.log(`  Latencia inbound→outbound (global): n=${o.n}  p50=${o.p50}ms  p95=${o.p95}ms  p99=${o.p99}ms  max=${o.max}ms`);
  } else {
    console.log(`  Latencia: sin pares inbound→outbound${s.latency_error ? ` (error: ${s.latency_error})` : ""}`);
  }
  if (s.latency_per_phase) {
    for (const p of s.latency_per_phase)
      console.log(`    · fase ${p.phase}: ${p.n != null ? `n=${p.n} p50=${p.p50} p95=${p.p95} p99=${p.p99} max=${p.max}` : p.error ?? "sin datos"}`);
  }
  if (s.loss) {
    const l = s.loss;
    console.log(
      `  Pérdidas: INBOUND=${l.inbound_total} (wamid distinto=${l.inbound_distinct_wamid}, sin wamid=${l.inbound_null_wamid}) · ` +
        `dup-wamid-grupos=${l.inbound_duplicate_wamid_groups} (${l.inbound_dedup_ok ? "OK dedupe" : "¡DUPLICADOS!"})`,
    );
    console.log(`  OUTBOUND=${l.outbound_total}  FAILED=${l.outbound_failed}`);
    if (s.outbound_failures_by_cause?.length)
      for (const c of s.outbound_failures_by_cause) console.log(`    · FAILED ${c.count} × ${c.cause}`);
  }
  if (s.sent_reconciliation) {
    const r = s.sent_reconciliation;
    if (r.present && r.missing_count != null)
      console.log(`  Sent-log: enviados=${r.sent_count} almacenados=${r.stored_distinct} faltan=${r.missing_count} extra=${r.extra_count} (${r.loss_ok ? "0 pérdidas" : "¡PÉRDIDA!"})`);
    else console.log(`  Sent-log: ${r.note ?? r.error ?? "n/d"}`);
  }
  if (s.money) {
    const m = s.money;
    console.log(
      `  Dinero: débitos=${m.debits_total} en ${m.orgs_with_debits} orgs · ` +
        `conversaciones con >1 débito=${m.conversations_debited_more_than_once} (${m.no_duplicate_debits_ok ? "OK" : "¡DUPLICADO!"}) · ` +
        `anomalía delta>=0=${m.debits_non_negative_anomaly}`,
    );
  }
  if (s.samples_rollup) {
    const q = s.samples_rollup;
    console.log(
      `  Colas (máx): inbound.wait=${q.queue_depth_max.inbound_wait} outbound.wait=${q.queue_depth_max.outbound_wait} ` +
        `failed(in/out)=${q.queue_failed_max.inbound}/${q.queue_failed_max.outbound} stalled(in/out)=${q.queue_stalled_max.inbound}/${q.queue_stalled_max.outbound}`,
    );
    console.log(`  PG (máx): conexiones=${q.pg_connections_max}/${q.pg_max_conn} active=${q.pg_active_max} idle_in_txn=${q.pg_idle_in_txn_max} locks=${q.pg_waiting_locks_max}`);
    const r = (x) => (x == null ? "-" : typeof x === "number" ? x.toFixed(0) : x);
    console.log(
      `  RSS api:    first=${r(q.rss_api_mb.first)} max=${r(q.rss_api_mb.max)} last=${r(q.rss_api_mb.last)} MB  growth=${q.rss_api_mb.growth_pct ?? "-"}%`,
    );
    console.log(
      `  RSS worker: first=${r(q.rss_worker_mb.first)} max=${r(q.rss_worker_mb.max)} last=${r(q.rss_worker_mb.last)} MB  growth=${q.rss_worker_mb.growth_pct ?? "-"}%`,
    );
  }
  console.log("════════════════════════════════════════════════════════");
}

async function runSummaryOnly() {
  console.log("────────────────────────────────────────────────────────────");
  console.log("  OBSERVABILIDAD · resumen de cierre (modo summary)");
  console.log(`  postgres : ${PG.user}@${PG.host}:${PG.port}/${PG.db}  (origen: ${PG.source})`);
  console.log("────────────────────────────────────────────────────────────");
  const summary = await computeSummary({ csvRollupFrom: null });
  const summaryPath = OUT(`summary-${fileStamp()}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  printSummary(summary);
  console.log(`\n  Summary : ${summaryPath}`);
}

// ─────────────────────── Entrada ───────────────────────
(async () => {
  if (MODE === "summary") await runSummaryOnly();
  else await runSampler();
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
