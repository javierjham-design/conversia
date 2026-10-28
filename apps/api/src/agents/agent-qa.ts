import { raiseException } from "@conversia/database";
import type { PrismaService } from "../prisma.service";
import { runAgentTest } from "./agent-test";

/**
 * V2-6 — AUTO-QA, autocorrección y auto-publicación. Nadie del equipo revisa cada alta: una
 * batería de escenarios por rubro corre contra el agente BORRADOR (modelo económico, sandbox).
 * Verde total → PUBLICA solo (auditado "auto-qa"). Fallo → UNA autocorrección acotada (se
 * refuerza el prompt y se re-corre); si persiste → NO publica + se reporta (cola V2-8) y el
 * checklist lo muestra honesto ("estamos afinando tu asistente"). Reusa el probador (runAgentTest).
 */

export type QaReply = { ok?: boolean; reply?: string; toolEvents?: unknown[]; humanHandoff?: boolean; error?: string };
export type QaScenario = { name: string; messages: { role: "user" | "assistant"; content: string }[]; assert: (r: QaReply) => { pass: boolean; reason?: string } };

/** Heurística regla 3: el bot NO debe inventar un precio. Falla si afirma un monto concreto SIN
 *  marcar que no lo tiene / que lo confirmará. */
export function assertNoInventedPrice(reply: string): boolean {
  const hasAmount = /\$\s?\d{2,3}([.,]\d{3})+|\b\d{3,}\s?(pesos|clp|usd)\b/i.test(reply);
  if (!hasAmount) return true;
  const hedged = /no (lo )?s[eé]\b|no tengo|no figura|no aparece|no est[aá] en|confirm|verificar|revisar|una persona|el equipo/i.test(reply);
  return hedged;
}

/** Batería universal (regla 3 + agendar + urgencia + una respuesta). Se complementa con los
 *  qaScenarios del paquete vertical si existen (definition.qaScenarios). */
export const DEFAULT_QA_SCENARIOS: QaScenario[] = [
  {
    name: "ofrece agendar",
    messages: [{ role: "user", content: "Hola, quiero reservar una hora para esta semana" }],
    assert: (r) => ({ pass: (r.toolEvents ?? []).some((t) => /agend|cita|appointment|slot|disponib/i.test(JSON.stringify(t))) || /agend|reserv|hora|disponib|cu[aá]ndo|d[ií]a/i.test(r.reply ?? ""), reason: "no ofreció agendar" }),
  },
  {
    name: "deriva urgencia a humano",
    messages: [{ role: "user", content: "Es una EMERGENCIA, me duele muchísimo y necesito ayuda ya" }],
    assert: (r) => ({ pass: r.humanHandoff === true || /humano|equipo|a la brevedad|de inmediato|urgen|emergen|llama|tel[eé]fono/i.test(r.reply ?? ""), reason: "no derivó la urgencia" }),
  },
  {
    name: "no inventa precios (regla 3)",
    messages: [{ role: "user", content: "¿Cuánto cuesta exactamente el servicio Premium XYZ Ultra que seguro no tienes en tu lista?" }],
    assert: (r) => ({ pass: assertNoInventedPrice(r.reply ?? ""), reason: "inventó un precio que no está en el catálogo" }),
  },
  {
    name: "responde (una respuesta por turno)",
    messages: [{ role: "user", content: "hola!" }],
    assert: (r) => ({ pass: !!(r.reply && r.reply.trim().length > 0), reason: "no respondió" }),
  },
];

const QA_CORRECTION =
  "\n\n## Correcciones de calidad (auto-QA)\n" +
  "- NUNCA inventes precios, horarios ni disponibilidad. Si no tienes el dato, dilo con naturalidad y ofrece que una persona del equipo lo confirme.\n" +
  "- Ante una urgencia o emergencia, deriva de inmediato a una persona (no intentes resolverla tú).\n" +
  "- Cuando el cliente quiera reservar, ofrece agendar con las herramientas disponibles.\n" +
  "- Responde en UN solo mensaje, breve y claro.";

export type QaResult = { ok: boolean; passed: boolean; published: boolean; corrected: boolean; results: { name: string; pass: boolean; reason?: string }[]; error?: string };

/** Carga escenarios del rubro (si el paquete vertical define qaScenarios) + los universales. */
function loadScenarios(defn: unknown): QaScenario[] {
  const extra: QaScenario[] = [];
  const list = (defn as any)?.qaScenarios;
  if (Array.isArray(list)) {
    for (const s of list) {
      if (s && typeof s.name === "string" && Array.isArray(s.messages)) {
        // Aserción declarativa mínima del paquete: expectKind ∈ agendar|urgencia|no_precio|responde.
        const kind = String(s.expect ?? "responde");
        const universal = DEFAULT_QA_SCENARIOS.find((d) => d.name.includes(kind === "agendar" ? "agendar" : kind === "urgencia" ? "urgencia" : kind === "no_precio" ? "inventa" : "una respuesta"));
        if (universal) extra.push({ name: `${s.name}`, messages: s.messages, assert: universal.assert });
      }
    }
  }
  return [...DEFAULT_QA_SCENARIOS, ...extra];
}

export async function runQaBattery(prisma: PrismaService, orgId: string, agentId: string, opts?: { autoPublish?: boolean }): Promise<QaResult> {
  const r = await correrBateria(prisma, orgId, agentId, opts);
  /**
   * V2-8 — un bot que no pasa la batería NO se publica, y el cliente se queda esperando un
   * asistente que nunca contesta. El copiloto se lo dice en el momento, pero nadie del lado
   * de la plataforma tenía la lista de clientes atascados así. Va FUERA de la transacción:
   * `withTenant` es una transacción y un fallo del accesorio abortaría la batería entera.
   * Una por agente (dedupe) hasta que se resuelva en la consola.
   */
  if (r.ok && !r.passed) {
    const fallan = r.results.filter((x) => !x.pass);
    await raiseException(prisma.admin, {
      organizationId: orgId,
      type: "qa_failed",
      severity: "warning",
      title: "El asistente no pasó la batería de calidad y quedó SIN publicar",
      detail: `Falló: ${fallan.map((f) => `${f.name}${f.reason ? ` (${f.reason})` : ""}`).join(" · ")}. El cliente no tiene bot atendiendo hasta que esto se corrija.`,
      dedupeKey: agentId,
    }).catch(() => undefined);
  }
  return r;
}

async function correrBateria(prisma: PrismaService, orgId: string, agentId: string, opts?: { autoPublish?: boolean }): Promise<QaResult> {
  return prisma.withTenant(orgId, async (tx) => {
    const draft = await tx.agentVersion.findFirst({ where: { agentId, status: "DRAFT" }, orderBy: { version: "desc" } });
    const version = draft ?? (await tx.agentVersion.findFirst({ where: { agentId, status: "PUBLISHED" }, orderBy: { version: "desc" } }));
    if (!version) return { ok: false, passed: false, published: false, corrected: false, results: [], error: "sin versión del agente" };
    const cfg = (version.config ?? {}) as Record<string, any>;
    // Escenarios universales (+ los del paquete vertical si la config del borrador los define).
    const scenarios = loadScenarios(cfg.verticalDefinition ?? cfg.qa);

    const toolsArr = Array.isArray(version.tools) ? (version.tools as string[]) : [];
    const buildInput = (prompt: string) => ({
      systemPrompt: prompt,
      config: { model: typeof cfg.model === "string" ? cfg.model : "gpt-4o-mini", maxTokens: 400, maxToolRounds: typeof cfg.maxToolRounds === "number" ? cfg.maxToolRounds : 3 },
      tools: toolsArr,
      actions: cfg.actions && typeof cfg.actions === "object" ? cfg.actions : undefined,
      messages: [] as { role: "user" | "assistant"; content: string }[],
    });

    const run = async (prompt: string, list: QaScenario[]) => {
      const out: { name: string; pass: boolean; reason?: string }[] = [];
      for (const s of list) {
        const r = (await runAgentTest(prisma, orgId, agentId, { ...buildInput(prompt), messages: s.messages } as any).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }))) as QaReply;
        const a = r.ok ? s.assert(r) : { pass: false, reason: r.error ?? "error del probador" };
        out.push({ name: s.name, pass: a.pass, reason: a.pass ? undefined : a.reason });
      }
      return out;
    };

    let results = await run(version.systemPrompt, scenarios);
    let corrected = false;
    let failing = results.filter((r) => !r.pass);

    // UNA autocorrección acotada: refuerza el prompt y re-corre SOLO los que fallaron.
    if (failing.length) {
      const correctedPrompt = version.systemPrompt + QA_CORRECTION;
      const reran = await run(correctedPrompt, scenarios.filter((s) => failing.some((f) => f.name === s.name)));
      if (reran.every((r) => r.pass)) {
        await tx.agentVersion.update({ where: { id: version.id }, data: { systemPrompt: correctedPrompt } });
        corrected = true;
        results = results.map((r) => (failing.some((f) => f.name === r.name) ? { name: r.name, pass: true } : r));
        failing = [];
      } else {
        results = results.map((r) => reran.find((x) => x.name === r.name) ?? r);
        failing = results.filter((r) => !r.pass);
      }
    }

    const passed = failing.length === 0;
    let published = false;
    if (passed && opts?.autoPublish !== false && draft) {
      const pub = await tx.agentVersion.update({ where: { id: draft.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
      await tx.agent.update({ where: { id: agentId }, data: { currentVersionId: pub.id } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorType: "system", actorId: "auto-qa", action: "agent.publish", entityType: "agent", entityId: agentId, after: { version: pub.version, autoQa: true, corrected } } });
      published = true;
    }
    return { ok: true, passed, published, corrected, results };
  });
}
