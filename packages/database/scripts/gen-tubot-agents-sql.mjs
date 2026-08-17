#!/usr/bin/env node
/**
 * Genera un SQL idempotente para configurar los 3 agentes del tenant de TuBot
 * (Comercial / Implementación / Soporte), leyendo los PROMPTS EXACTOS desde
 * docs/TUBOT_TENANT.md (§3/§4/§5) — así no hay riesgo de transcribirlos mal.
 *
 * Uso:
 *   node packages/database/scripts/gen-tubot-agents-sql.mjs
 *   -> escribe packages/database/scripts/seed-tubot-agents.sql
 * Luego (contra PROD, con TU url):
 *   psql "$DATABASE_PUBLIC_URL" -f packages/database/scripts/seed-tubot-agents.sql
 *
 * Es idempotente: si el agente ya existe, ACTUALIZA su versión publicada
 * (system_prompt + tools) PRESERVANDO config (el modelo por-agente que fijaste en
 * el Super Admin). Si no existe, crea la v1 publicada. Verifica el org antes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const docPath = resolve(repoRoot, "docs/TUBOT_TENANT.md");
const outPath = resolve(__dirname, "seed-tubot-agents.sql");

// Org del tenant de TuBot (info.tubot@gmail.com). Verifica que sea el tuyo.
const ORG_ID = "cms5zmgtz0001od01t30lw4t6";

const AGENTS = [
  { slug: "comercial", name: "Asesor Comercial", kind: "sales", heading: "## 3. ASESOR COMERCIAL — prompt final",
    tools: ["updateContactFields", "updateLeadStatus", "addTag", "searchKnowledgeBase", "transferToAgent", "transferToHuman"] },
  { slug: "implementacion", name: "Asesor de Implementación", kind: "custom", heading: "## 4. ASESOR DE IMPLEMENTACIÓN — prompt final",
    tools: ["updateContactFields", "addInternalNote", "searchKnowledgeBase", "transferToHuman", "triggerWorkflow"] },
  { slug: "soporte", name: "Soporte", kind: "support", heading: "## 5. SOPORTE — prompt final",
    tools: ["searchKnowledgeBase", "addInternalNote", "transferToHuman", "transferToAgent"] },
];

const doc = readFileSync(docPath, "utf8");

/** Extrae el primer bloque ``` ... ``` que aparece tras un encabezado. */
function extractPrompt(heading) {
  const at = doc.indexOf(heading);
  if (at < 0) throw new Error(`No encontré el encabezado: ${heading}`);
  const fenceStart = doc.indexOf("```", at);
  if (fenceStart < 0) throw new Error(`No encontré el bloque de código tras: ${heading}`);
  const bodyStart = doc.indexOf("\n", fenceStart) + 1;
  const fenceEnd = doc.indexOf("```", bodyStart);
  if (fenceEnd < 0) throw new Error(`Bloque de código sin cierre tras: ${heading}`);
  return doc.slice(bodyStart, fenceEnd).replace(/\s+$/, "");
}

/** Dollar-quote seguro para PostgreSQL (evita cualquier problema de comillas/saltos). */
function dq(text) {
  let tag = "$prompt$";
  let i = 0;
  while (text.includes(tag)) tag = `$p${i++}$`;
  return `${tag}${text}${tag}`;
}

let sql = `-- Generado por gen-tubot-agents-sql.mjs — configura los 3 agentes de TuBot.
-- Idempotente. Ejecuta contra PROD:  psql "$DATABASE_PUBLIC_URL" -f seed-tubot-agents.sql
-- Preserva el modelo por-agente (config) ya fijado en el Super Admin.

DO $$
DECLARE v_org text := '${ORG_ID}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RAISE EXCEPTION 'La organización % no existe — revisa ORG_ID', v_org;
  END IF;
END $$;
`;

for (const a of AGENTS) {
  const prompt = extractPrompt(a.heading);
  const toolsJson = JSON.stringify(a.tools);
  sql += `
-- ===== ${a.name} (${a.slug}) =====
DO $$
DECLARE
  v_org text := '${ORG_ID}';
  v_slug text := '${a.slug}';
  v_name text := '${a.name.replace(/'/g, "''")}';
  v_kind text := '${a.kind}';
  v_tools jsonb := '${toolsJson}'::jsonb;
  v_prompt text := ${dq(prompt)};
  v_agent_id text;
  v_cur text;
  v_ver_id text;
  v_ver int;
BEGIN
  SELECT id, current_version_id INTO v_agent_id, v_cur
    FROM agents WHERE organization_id = v_org AND slug = v_slug AND deleted_at IS NULL;
  IF v_agent_id IS NULL THEN
    v_agent_id := 'agent_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO agents (id, organization_id, slug, name, kind, active, created_at, updated_at)
      VALUES (v_agent_id, v_org, v_slug, v_name, v_kind, true, now(), now());
    v_cur := NULL;
  ELSE
    UPDATE agents SET name = v_name, kind = v_kind, active = true, updated_at = now() WHERE id = v_agent_id;
  END IF;

  IF v_cur IS NOT NULL THEN
    -- Actualiza la versión publicada actual, PRESERVANDO config (modelo por-agente).
    UPDATE agent_versions
       SET system_prompt = v_prompt, tools = v_tools, status = 'PUBLISHED', published_at = now()
     WHERE id = v_cur;
  ELSE
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_ver FROM agent_versions WHERE agent_id = v_agent_id;
    v_ver_id := 'av_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO agent_versions (id, organization_id, agent_id, version, status, system_prompt, config, tools, published_at, created_at)
      VALUES (v_ver_id, v_org, v_agent_id, v_ver, 'PUBLISHED', v_prompt, '{}'::jsonb, v_tools, now(), now());
    UPDATE agents SET current_version_id = v_ver_id WHERE id = v_agent_id;
  END IF;
  RAISE NOTICE 'Agente % configurado (%).', v_slug, v_name;
END $$;
`;
}

writeFileSync(outPath, sql, "utf8");
console.log(`✔ SQL generado: ${outPath}`);
console.log(`  Agentes: ${AGENTS.map((a) => a.slug).join(", ")}`);
console.log(`  Prompts leídos del doc (§3/§4/§5) sin transcripción manual.`);
