import { z } from "zod";
import type { AssistantAction } from "@conversia/types";

/**
 * COP ETAPA 1 — PROTOCOLO DE ACCIONES del copiloto, validado EN EL SERVIDOR.
 *
 * El copiloto dejó de ser un chat que explica para pasar a uno que acompaña: navega,
 * resalta y entrega botones. Eso significa que lo que decide el modelo termina moviendo
 * la pantalla del dueño, así que nada sale de aquí sin pasar por una lista blanca:
 *
 *  - `navigate` solo a rutas que EXISTEN en conversia-web. El hallazgo 4 de la auditoría
 *    fue exactamente esto al revés (CTAs a rutas de TuBot → 404 para el cliente guiado);
 *    `actions-routes.spec.ts` recorre el árbol real de páginas y falla si una ruta de esta
 *    lista no existe.
 *  - `highlight` solo a elementos marcados con `data-copilot="<id>"`. Los ids son CONTRATO:
 *    el mismo spec falla si uno de esta lista no está en el código de la web.
 *  - `button` es la única vía para PAGAR y para CONECTAR WHATSAPP. No es una preferencia de
 *    diseño: el navegador bloquea el popup de Meta si no nace de un clic del usuario, y
 *    cobrarle a alguien sin que toque el botón no se hace.
 *
 * Las acciones las produce el servidor a partir de lo que hizo cada herramienta (ver
 * `setup-tools.ts`), NO el texto libre del modelo: el modelo elige la herramienta, el
 * servidor decide qué acción corresponde. Así una respuesta alucinada no puede inventar
 * un botón de pago ni mandar al cliente a una pantalla que no existe.
 */

/** Rutas de conversia-web a las que el copiloto puede navegar o apuntar un botón interno. */
export const NAVIGATE_ALLOWED = [
  "/inicio",
  "/ajustes",
  "/agenda",
  "/agenda/configurar",
  "/canales",
  "/cobros",
  "/conversaciones",
  "/clientes",
  "/mini-sitio",
  "/crear",
] as const;

/**
 * Elementos que el copiloto puede resaltar. Van marcados con `data-copilot="<id>"` en
 * conversia-web; el spec de rutas comprueba que cada uno exista de verdad en el código.
 */
export const COPILOT_TARGETS = [
  "negocio-datos", // tarjeta "Tu negocio" en /ajustes
  "negocio-horario", // horario de atención en /ajustes
  "servicios", // servicios con precio y duración en /agenda/configurar
  "profesionales", // equipo y recursos con su horario en /agenda/configurar
  "reglas-reserva", // bloque entre horas y anticipación en /agenda/configurar
  "conectar-whatsapp", // camino de conexión en /canales
  "plan", // activar plan / cargar tarjeta en /cobros
  "comprar-creditos", // packs en /cobros
  // §5 — el copiloto tiene que poder señalar las dos piezas del cobro automático, que es
  // lo que decide si al cliente se le pausa el asistente o no. Antes solo podía apuntar a
  // "plan", y "activa tu plan" no dice nada sobre la tarjeta ni sobre la recarga.
  "cobros-metodo-pago", // registrar/cambiar la tarjeta en /cobros
  "cobros-recarga-automatica", // interruptor, pack, umbral y tope en /cobros
] as const;

export type CopilotTarget = (typeof COPILOT_TARGETS)[number];

/** Tope de acciones por turno: más que esto no es acompañar, es marear. */
export const MAX_ACTIONS_PER_TURN = 4;

const navigateSchema = z.object({ type: z.literal("navigate"), to: z.enum(NAVIGATE_ALLOWED) });
const highlightSchema = z.object({
  type: z.literal("highlight"),
  target: z.enum(COPILOT_TARGETS),
  text: z.string().trim().min(1).max(160),
});
const buttonSchema = z.object({
  type: z.literal("button"),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(["whatsapp", "pago", "interno", "externo"]),
  payload: z.string().trim().max(300).optional(),
});
const refreshSchema = z.object({ type: z.literal("checklist_refresh") });
const celebrateSchema = z.object({ type: z.literal("celebrate"), step: z.string().trim().min(1).max(40) });

export const assistantActionSchema = z.discriminatedUnion("type", [
  navigateSchema,
  highlightSchema,
  buttonSchema,
  refreshSchema,
  celebrateSchema,
]);

/** Clave de identidad de una acción (para no repetir la misma dos veces en un turno). */
function actionKey(a: AssistantAction): string {
  switch (a.type) {
    case "navigate":
      return `navigate:${a.to}`;
    case "highlight":
      return `highlight:${a.target}`;
    case "button":
      return `button:${a.kind}:${a.payload ?? ""}`;
    case "celebrate":
      return `celebrate:${a.step}`;
    default:
      return a.type;
  }
}

/** Orden en que la UI las ejecuta: primero mover la pantalla, después señalar y ofrecer. */
const ORDER: Record<AssistantAction["type"], number> = {
  navigate: 0,
  highlight: 1,
  celebrate: 2,
  button: 3,
  checklist_refresh: 4,
};

/**
 * Deja pasar solo lo válido: descarta lo que no cumple el esquema (incluida una ruta o un
 * `data-copilot` fuera de la lista blanca), quita repetidas, deja UNA sola navegación —la
 * primera— y corta en `MAX_ACTIONS_PER_TURN`. Pura y testeable: la UI confía en que lo que
 * recibe ya está limpio, así que el filtro vive aquí y no allá.
 *
 * Un `payload` de botón `interno` también tiene que ser una ruta de la lista blanca: si no,
 * el botón navegaría a donde el modelo quiera, que es justo lo que `navigate` no permite.
 */
export function sanitizeActions(raw: unknown): AssistantAction[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantAction[] = [];
  const seen = new Set<string>();
  let navigated = false;
  for (const candidate of raw) {
    const parsed = assistantActionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const action = parsed.data as AssistantAction;
    if (action.type === "navigate") {
      if (navigated) continue;
      navigated = true;
    }
    if (action.type === "button" && action.kind === "interno") {
      const to = (action.payload ?? "").split("?")[0];
      if (!(NAVIGATE_ALLOWED as readonly string[]).includes(to)) continue;
    }
    if (action.type === "button" && action.kind === "externo") {
      // Un enlace externo del copiloto solo puede ser https (nunca javascript:, data: ni http).
      if (!/^https:\/\//i.test(action.payload ?? "")) continue;
    }
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out.sort((a, b) => ORDER[a.type] - ORDER[b.type]).slice(0, MAX_ACTIONS_PER_TURN);
}

/** ¿Esta ruta es una pantalla a la que el copiloto puede mandar? */
export function isNavigable(to: string): boolean {
  return (NAVIGATE_ALLOWED as readonly string[]).includes(to.split("?")[0]);
}
