// Recomendaciones de plantillas por rubro. Reutiliza las plantillas GENÉRICAS y
// parametrizables (agentes y flujos) — sin datos de ningún tenant — y sugiere el
// subconjunto que mejor encaja en cada industria. Al instalar un flujo se crea
// como BORRADOR para que el tenant lo revise, ajuste con su vocabulario y publique.
import { AGENT_TEMPLATES } from "./agent-templates";
import { WORKFLOW_TEMPLATES } from "./workflow-templates";

/** Por rubro: qué plantillas de agente y de flujo recomendar (por `key`). */
export const INDUSTRY_RECOMMENDATIONS: Record<string, { agents: string[]; flows: string[] }> = {
  generico: { agents: ["recepcion", "calificador"], flows: ["bienvenida-lead", "seguimiento-sin-respuesta"] },
  comercio: { agents: ["recepcion", "soporte"], flows: ["bienvenida-lead", "palabra-clave-precios", "seguimiento-sin-respuesta"] },
  servicios: { agents: ["recepcion", "agendador", "calificador"], flows: ["bienvenida-lead", "seguimiento-sin-respuesta"] },
  salud: { agents: ["agendador", "recepcion"], flows: ["bienvenida-lead", "seguimiento-sin-respuesta"] },
  educacion: { agents: ["recepcion", "calificador", "agendador"], flows: ["bienvenida-lead", "palabra-clave-precios"] },
  inmobiliaria: { agents: ["calificador", "agendador"], flows: ["bienvenida-lead", "seguimiento-sin-respuesta"] },
  fitness: { agents: ["agendador", "recepcion"], flows: ["bienvenida-lead", "encuesta-post-cierre"] },
  automotriz: { agents: ["agendador", "recepcion"], flows: ["bienvenida-lead", "seguimiento-sin-respuesta"] },
  turismo: { agents: ["recepcion", "calificador"], flows: ["bienvenida-lead", "palabra-clave-precios"] },
};

export function recommendedFor(industry: string) {
  const rec = INDUSTRY_RECOMMENDATIONS[industry] ?? INDUSTRY_RECOMMENDATIONS.generico;
  return {
    agents: AGENT_TEMPLATES.filter((t) => rec.agents.includes(t.key)),
    flows: WORKFLOW_TEMPLATES.filter((t) => rec.flows.includes(t.key)),
  };
}
