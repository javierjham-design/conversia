/**
 * Limpieza puntual (incidente V2-7): borra de Meta + de la BD las plantillas estándar
 * cv_* que la auto-creación sin gating creó por error en WABAs de marca != conversia
 * (TuBot). Idempotente y acotado: SOLO toca los 4 nombres estándar en orgs no-conversia.
 *
 * Requiere en el entorno: CREDENTIALS_ENCRYPTION_KEY, META_APP_SECRET, META_GRAPH_VERSION
 * (y META_ACCESS_TOKEN como fallback). DB vía DATABASE_PUBLIC_URL (o DATABASE_URL).
 * No imprime secretos. DRY_RUN=1 para solo listar sin borrar.
 *
 * Ejecutar con el env del servicio que tiene los secretos, p. ej.:
 *   railway run -s api -- node packages/database/scripts/cleanup-cv-templates.mjs
 * (si DATABASE_URL del servicio es .internal y no resuelve local, exportar
 *  DATABASE_PUBLIC_URL del servicio Postgres antes de correr.)
 */
import { PrismaClient } from "@prisma/client";
import { createHmac, createDecipheriv } from "node:crypto";

const STANDARD = ["cv_bienvenida", "cv_recordatorio_cita", "cv_confirmacion_cita", "cv_reactivacion"];
const DRY = process.env.DRY_RUN === "1";
const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const encKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
const appSecret = process.env.META_APP_SECRET || "";
const version = process.env.META_GRAPH_VERSION || "v21.0";
const globalToken = process.env.META_ACCESS_TOKEN || "";

if (!dbUrl) throw new Error("falta DATABASE_PUBLIC_URL/DATABASE_URL");
if (!encKey) throw new Error("falta CREDENTIALS_ENCRYPTION_KEY");

function decrypt(payload) {
  const key = Buffer.from(encKey, "hex");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
function withProof(url, token) {
  if (!appSecret || !token) return url;
  const proof = createHmac("sha256", appSecret).update(token).digest("hex");
  return url + (url.includes("?") ? "&" : "?") + "appsecret_proof=" + proof;
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const rows = await prisma.$queryRawUnsafe(
  `SELECT t.id, t.name, a.waba_id, a.credential_id, c.ciphertext
   FROM whatsapp_templates t
   JOIN organizations o ON o.id = t.organization_id
   JOIN whatsapp_accounts a ON a.id = t.account_id
   LEFT JOIN integration_credentials c ON c.id = a.credential_id
   WHERE COALESCE(o.brand,'tubot') <> 'conversia' AND t.name = ANY($1::text[])`,
  STANDARD,
);
console.log(`${rows.length} filas cv_* en orgs != conversia${DRY ? " (DRY_RUN)" : ""}`);

const byWaba = new Map();
for (const r of rows) {
  if (!byWaba.has(r.waba_id)) byWaba.set(r.waba_id, { token: r.ciphertext ? safeDecrypt(r.ciphertext) : globalToken, ids: [], names: new Set() });
  const e = byWaba.get(r.waba_id);
  e.ids.push(r.id);
  e.names.add(r.name);
}
function safeDecrypt(ct) { try { return decrypt(ct); } catch { return globalToken; } }

let okRows = [];
for (const [waba, e] of byWaba) {
  if (!e.token) { console.error(`✖ ${waba}: sin token, salto`); continue; }
  for (const name of e.names) {
    const url = withProof(`https://graph.facebook.com/${version}/${encodeURIComponent(waba)}/message_templates?name=${encodeURIComponent(name)}`, e.token);
    if (DRY) { console.log(`DRY DELETE ${waba} ${name}`); continue; }
    try {
      const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.success !== false) { console.log(`✔ Meta borró ${name} en ${waba}`); }
      else if (j?.error?.code === 100 && /does not exist|no existe/i.test(j?.error?.message || "")) { console.log(`• ${name} ya no existe en ${waba}`); }
      else { console.error(`✖ ${name}@${waba}: ${j?.error?.message ?? res.status}`); continue; }
    } catch (err) { console.error(`✖ ${name}@${waba}:`, err.message); continue; }
  }
  okRows.push(...e.ids);
}
if (!DRY && okRows.length) {
  const del = await prisma.whatsappTemplate.deleteMany({ where: { id: { in: okRows } } });
  console.log(`✔ BD: ${del.count} filas cv_* borradas`);
}
await prisma.$disconnect();
