/**
 * ¿ESTÁ VIGENTE EL SERVICIO DEL TENANT? — regla ÚNICA, pura y testeable.
 *
 * El caso real (11-nov-2026). `digital-dent-temuco` no podía conectar su WhatsApp: cada
 * intento moría en un 403 «La vigencia de tu servicio venció». Su `settings.validUntil`
 * decía 2-nov —la ventana de prueba del día que se creó la cuenta— mientras su suscripción
 * estaba ACTIVE hasta el 11-dic. Dos fuentes de verdad peleadas, y la que ganaba era la
 * equivocada. Había CUATRO cuentas así, todas con la suscripción al día.
 *
 * Por qué pasó. `validUntil` se escribe al crear la cuenta (la prueba) y lo actualiza el
 * camino de PAGO (`billing.controller`, que por eso lleva su comentario explicando que sin
 * eso un tenant que paga dentro de la prueba quedaría bloqueado). Pero `period_end` se mueve
 * desde más lugares —el Super Admin, el ciclo de prueba, el cobro recurrente— y ninguno de
 * esos tocaba `validUntil`. Cada camino nuevo vuelve a olvidarlo: es una trampa estructural,
 * no un descuido.
 *
 * Por eso esto NO se arregla sincronizando a los llamadores. La regla pasa a UN solo lugar y
 * deja de ser posible que se contradigan: **una suscripción viva que cubre el día de hoy
 * manda sobre un `validUntil` viejo.** Al revés no: `validUntil` sigue mandando cuando no hay
 * suscripción que cubra (cuentas manuales, anuales sueltas, cortes a mano).
 *
 * Lo que esto NO toca: la suspensión de verdad. Cortarle a un cliente se hace con
 * `organization.status` (SUSPENDED/CANCELLED), que se mira aparte y sigue bloqueando. Esta
 * regla solo deja de bloquear a quien la facturación dice que está al día.
 *
 * Importa en DOS caminos que hoy leen `validUntil` por su cuenta:
 *  - `plan-limits.assertOrgActive` (api) — 403 al crear cualquier recurso.
 *  - `agent-turn` (worker) — **la IA deja de contestar**, que es lo caro: el bot queda mudo
 *    y en la pantalla no se ve nada.
 */

/** Estados de suscripción que acreditan servicio al día. Mismos que usa el motor de límites. */
export const ESTADOS_DE_SUSCRIPCION_VIVA = ["ACTIVE", "TRIALING"] as const;

export type MotivoDeVigencia =
  /** No hay fecha de corte: el servicio no vence por esta vía. */
  | "sin_vencimiento"
  /** La fecha de corte todavía no llegó. */
  | "al_dia"
  /** La fecha de corte pasó, pero la suscripción cubre hoy (el caso de Digital-Dent). */
  | "cubierto_por_suscripcion"
  /** La fecha de corte pasó y no hay suscripción que cubra hoy. */
  | "vencida";

export interface EstadoDeVigencia {
  vigente: boolean;
  motivo: MotivoDeVigencia;
  /** La fecha de corte leída, en ISO, o null si no había una usable. */
  validUntil: string | null;
  /** Hasta cuándo cubre la suscripción, en ISO, o null si no cubre. */
  cubiertoHasta: string | null;
}

export interface SuscripcionParaVigencia {
  status: string | null | undefined;
  periodEnd: Date | string | null | undefined;
}

/** Fecha utilizable o null: un valor raro en un JSON no puede decidir un corte de servicio. */
function fecha(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Evalúa la vigencia del servicio.
 *
 * `validUntil` sale de `organization.settings.validUntil` tal cual (sin confiar en su tipo).
 * `suscripcion` es la última suscripción del tenant, o null si no tiene.
 */
export function evaluarVigencia(input: {
  validUntil: unknown;
  suscripcion?: SuscripcionParaVigencia | null;
  ahora?: Date;
}): EstadoDeVigencia {
  const ahora = input.ahora ?? new Date();
  const corte = fecha(input.validUntil);

  // Sin fecha de corte usable no hay nada que vencer. Es el estado de la mayoría.
  if (!corte) return { vigente: true, motivo: "sin_vencimiento", validUntil: null, cubiertoHasta: null };

  const iso = corte.toISOString();
  if (corte.getTime() >= ahora.getTime()) {
    return { vigente: true, motivo: "al_dia", validUntil: iso, cubiertoHasta: null };
  }

  // La fecha pasó: la facturación tiene la última palabra.
  const sub = input.suscripcion ?? null;
  const estadoVivo = Boolean(sub?.status && (ESTADOS_DE_SUSCRIPCION_VIVA as readonly string[]).includes(sub.status));
  const fin = fecha(sub?.periodEnd);
  if (estadoVivo && fin && fin.getTime() > ahora.getTime()) {
    return { vigente: true, motivo: "cubierto_por_suscripcion", validUntil: iso, cubiertoHasta: fin.toISOString() };
  }

  return { vigente: false, motivo: "vencida", validUntil: iso, cubiertoHasta: null };
}

/** Atajo para los dos guardianes: solo el booleano. */
export function servicioVigente(input: {
  validUntil: unknown;
  suscripcion?: SuscripcionParaVigencia | null;
  ahora?: Date;
}): boolean {
  return evaluarVigencia(input).vigente;
}

/**
 * Frase para el dueño cuando NO está vigente. En castellano y sin jerga: la ve en un 403 y
 * se la dice Convi. Nunca menciona `validUntil` ni nombres de columnas.
 */
export function frasePorVigenciaVencida(e: EstadoDeVigencia): string {
  if (e.vigente) return "";
  return "La vigencia de tu servicio venció. Renueva para seguir operando.";
}
