import { findStartNode, nextNodeId, renderVars } from "@conversia/workflows";
import type { WorkflowDefinition } from "@conversia/types";

export interface SimStep {
  nodeId: string;
  nodeType: string;
  label: string;
  detail: string;
}

export interface SimNames {
  leadStatus: Record<string, string>;
  agent: Record<string, string>;
  team: Record<string, string>;
  user: Record<string, string>;
}

const UNIT: Record<string, string> = { minutes: "minuto(s)", hours: "hora(s)", days: "día(s)" };

/**
 * Recorre el workflow como lo haría el motor, pero SIN efectos: describe qué
 * haría cada nodo. Las esperas no pausan (se anotan y se sigue) y las
 * condiciones toman la rama indicada por `assumeNoReply`. Es el "modo prueba"
 * del editor: no persiste nada ni envía nada por los canales.
 */
export function simulateWorkflow(
  def: WorkflowDefinition,
  opts: { vars: Record<string, string>; names: SimNames; assumeNoReply: boolean },
): SimStep[] {
  const { vars, names, assumeNoReply } = opts;
  const trace: SimStep[] = [];
  let current: string | undefined = findStartNode(def)?.id;
  const seen = new Set<string>();
  let guard = 0;

  while (current && guard++ < 60) {
    const node = def.nodes.find((n) => n.id === current);
    if (!node) break;
    const cfg = (node.config ?? {}) as Record<string, any>;
    let label: string = node.type;
    let detail = "";
    let branch: string | undefined;

    switch (node.type) {
      case "send_text":
        label = "Enviar mensaje";
        detail = renderVars(String(cfg.text ?? ""), vars) || "(sin texto)";
        break;
      case "run_agent":
        label = "Ejecutar agente IA";
        detail = cfg.agentSlug ? `Cedería la conversación a “${names.agent[cfg.agentSlug] ?? cfg.agentSlug}”` : "Respondería el agente activo";
        break;
      case "wait": {
        label = "Esperar";
        const v = cfg.days ?? cfg.hours ?? cfg.minutes ?? 0;
        const u = cfg.days ? "days" : cfg.hours ? "hours" : "minutes";
        detail = `Pausaría ${v} ${UNIT[u]}${cfg.cancelOn === "contact_reply" ? " (se cancela si el contacto responde)" : ""}`;
        break;
      }
      case "wait_reply": {
        label = "¿El contacto respondió?";
        const v = cfg.days ?? cfg.hours ?? cfg.minutes ?? 0;
        const u = cfg.days ? "days" : cfg.hours ? "hours" : "minutes";
        branch = assumeNoReply ? "no_reply" : "replied";
        detail = `Esperaría la respuesta hasta ${v} ${UNIT[u]} → sigue por «${assumeNoReply ? "No respondió" : "Sí, respondió"}» (simulado)`;
        break;
      }
      case "condition":
        label = "Condición";
        branch = assumeNoReply ? "true" : "false";
        detail = `¿El contacto sigue sin responder? → sigue por «${assumeNoReply ? "sin respuesta" : "respondió"}» (simulado)`;
        break;
      case "update_lead_status":
        label = "Cambiar estado del lead";
        detail = `→ ${names.leadStatus[cfg.statusCode] ?? cfg.statusCode ?? "(sin estado)"}`;
        break;
      case "add_tag":
        label = "Agregar etiqueta";
        detail = cfg.tag ? `#${cfg.tag}` : "(sin etiqueta)";
        break;
      case "remove_tag":
        label = "Quitar etiqueta";
        detail = cfg.tag ? `quitar #${cfg.tag}` : "(sin etiqueta)";
        break;
      case "update_contact": {
        label = "Actualizar datos del contacto";
        const fields = (cfg.fields ?? {}) as Record<string, string>;
        const es: Record<string, string> = { firstName: "nombre", lastName: "apellido", email: "email" };
        const parts = Object.entries(fields)
          .filter(([, v]) => String(v ?? "").trim())
          .map(([k, v]) => `${es[k] ?? k} = ${renderVars(String(v), vars)}`);
        detail = parts.length ? parts.join(", ") : "(sin cambios)";
        break;
      }
      case "assign_user":
        label = "Asignar a usuario";
        detail = names.user[cfg.userId] ?? cfg.userId ?? "(sin usuario)";
        break;
      case "assign_team":
        label = "Asignar a equipo";
        detail = names.team[cfg.teamId] ?? cfg.teamId ?? "(sin equipo)";
        break;
      case "switch_agent":
        label = "Cambiar agente IA";
        detail = `“${names.agent[cfg.agentSlug] ?? cfg.agentSlug ?? "(sin agente)"}” tomaría el control`;
        break;
      case "transfer_human":
        label = "Escalar a humano";
        detail = cfg.reason ? String(cfg.reason) : "Pausaría la IA y avisaría al equipo";
        break;
      case "close_conversation":
        label = "Cerrar conversación";
        detail = "Marcaría la conversación como cerrada";
        break;
      case "start_workflow":
        label = "Disparar otro flujo";
        detail = cfg.workflowName ? `«${cfg.workflowName}»` : "(sin flujo)";
        break;
      case "stop":
        label = "Terminar flujo";
        detail = "Fin de la ejecución";
        break;
      case "open_conversation":
        label = "Abrir conversación";
        detail = "Abriría/reutilizaría una conversación del contacto";
        break;
      case "add_note":
        label = "Añadir comentario";
        detail = renderVars(String(cfg.text ?? ""), vars) || "(sin comentario)";
        break;
      case "goto":
        label = "Saltar a otro paso";
        detail = cfg.targetNodeId ? `Continuaría en el paso ${cfg.targetNodeId}` : "(sin destino)";
        break;
      case "business_hours":
        label = "Fecha y hora";
        branch = "in"; // en la prueba asumimos dentro de horario
        detail = "Ramificaría según el horario → asumimos «Dentro de horario» (simulado)";
        break;
      case "send_capi":
        label = "Enviar evento CAPI (Meta)";
        detail = `Enviaría el evento “${cfg.eventName ?? "Lead"}”${cfg.value ? ` por $${cfg.value} ${cfg.currency ?? "CLP"}` : ""} (simulado)`;
        break;
      case "ai_objective":
        label = "Agente IA con objetivo";
        branch = "met"; // en la prueba asumimos objetivo cumplido
        detail = `El agente buscaría: “${cfg.objective ?? ""}”${Number(cfg.maxTurns ?? 1) > 1 ? ` durante hasta ${cfg.maxTurns} turnos del contacto (timeout ${cfg.timeoutHours ?? 24} h)` : ""} → asumimos «Objetivo cumplido» (simulado)`;
        break;
      case "call_api":
        label = "Petición HTTP";
        detail = `${cfg.method ?? "GET"} ${renderVars(String(cfg.url ?? ""), vars) || "(sin URL)"} (no se ejecuta en la prueba)`;
        break;
      case "send_template":
        label = "Plantilla WhatsApp";
        detail = "(enviaría la plantilla HSM elegida con las variables reales del contacto — sirve fuera de la ventana de 24 h; no se envía en la prueba)";
        break;
      case "send_internal_email":
        label = "Correo interno";
        detail = `enviaría «${renderVars(String(cfg.subject ?? ""), vars)}» a ${(Array.isArray(cfg.to) ? (cfg.to as string[]) : []).join(", ") || "(sin destinatarios)"} — equipo interno, no se envía en la prueba`;
        break;
      case "send_ga4_event":
        label = "Evento GA4";
        detail = `enviaría «${String(cfg.eventName ?? "")}» a Google Analytics (no se envía en la prueba)`;
        break;
      case "google_sheets_append":
        label = "Google Sheets";
        detail = `agregaría una fila con ${(Array.isArray(cfg.values) ? (cfg.values as string[]) : []).length} columna(s) a la planilla (no se envía en la prueba)`;
        break;
      case "send_tiktok_event":
        label = "Integración";
        detail = "(Próximamente — este paso aún no envía nada)";
        break;
      default:
        detail = "(este paso no tiene efecto en el motor)";
    }

    trace.push({ nodeId: node.id, nodeType: node.type, label, detail });
    if (node.type === "stop") break;
    if (seen.has(node.id) && branch === undefined) {
      // Protección extra contra ciclos sin condición.
      trace.push({ nodeId: node.id, nodeType: "loop", label: "Ciclo detectado", detail: "El recorrido se detuvo para evitar un bucle." });
      break;
    }
    seen.add(node.id);
    // "Saltar a otro paso": el recorrido sigue el destino configurado.
    current = node.type === "goto" && cfg.targetNodeId ? String(cfg.targetNodeId) : nextNodeId(def, node.id, branch);
  }

  return trace;
}
