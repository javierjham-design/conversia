/**
 * ETAPA 0 (hallazgo 1) — traduce el resultado de la batería de auto-QA (`runQaBattery`) a
 * LENGUAJE SIMPLE para el dueño del negocio, que no es técnico. Nada de "assert", "scenario"
 * ni "tool events": qué le escribimos al bot, qué hizo mal y qué tocar para arreglarlo.
 *
 * Se usa en el endpoint de publicación del cliente (POST /agents/:id/qa-publish). El detalle
 * técnico (`reason` de cada escenario) viaja aparte, en `escenarios`, para soporte.
 */

export type QaFailureKind = "agenda" | "urgencia" | "precio" | "silencio" | "tecnico";

export type QaProblem = {
  /** Nombre del escenario que falló (ya viene en español en la batería). */
  escenario: string;
  kind: QaFailureKind;
  titulo: string;
  queSignifica: string;
  comoArreglarlo: string;
};

const COPY: Record<QaFailureKind, Omit<QaProblem, "escenario" | "kind">> = {
  agenda: {
    titulo: "No ofreció agendar una hora",
    queSignifica:
      "Le escribimos como si fuéramos un cliente pidiendo una hora para esta semana y tu asistente no propuso ningún día ni horario.",
    comoArreglarlo:
      "En las instrucciones de tu asistente dile que, cuando alguien quiera reservar, ofrezca los horarios disponibles y confirme la cita. Revisa también que tengas al menos un profesional con su horario cargado en Agenda.",
  },
  urgencia: {
    titulo: "No avisó a una persona ante una urgencia",
    queSignifica:
      "Simulamos un cliente con una emergencia y tu asistente intentó resolverlo solo, sin pasarle el caso a alguien de tu equipo.",
    comoArreglarlo:
      "Agrega esta regla a tu asistente: ante una urgencia o emergencia, responder con calma y derivar de inmediato a una persona del equipo.",
  },
  precio: {
    titulo: "Dijo un precio que no está en tu lista",
    queSignifica:
      "Le preguntamos por un servicio que no existe y tu asistente igual inventó un valor. Eso te puede dejar comprometido con un precio equivocado.",
    comoArreglarlo:
      "Carga tus servicios con su precio en la sección Servicios y pídele que, cuando no tenga el dato, lo diga con naturalidad y ofrezca que una persona del equipo lo confirme.",
  },
  silencio: {
    titulo: "Se quedó sin responder",
    queSignifica: "Le escribimos un saludo simple y no contestó nada.",
    comoArreglarlo:
      "Revisa que las instrucciones de tu asistente no estén vacías y que tenga un saludo de bienvenida. Si recién lo creaste, guárdalo de nuevo y vuelve a probar.",
  },
  tecnico: {
    titulo: "No pudimos terminar la prueba",
    queSignifica:
      "Hubo un problema técnico mientras probábamos tu asistente, así que preferimos no publicarlo todavía.",
    comoArreglarlo:
      "Vuelve a intentarlo en un minuto. Si sigue pasando, escríbenos y lo revisamos nosotros.",
  },
};

/** Patrones sobre el motivo que devuelve la batería (y, si no alcanza, sobre el nombre). */
function kindFrom(text: string): QaFailureKind | undefined {
  const t = text.toLowerCase();
  if (!t) return undefined;
  if (/precio|monto|valor|catálogo|catalogo/.test(t)) return "precio";
  if (/urgen|emergen|humano|deriv/.test(t)) return "urgencia";
  if (/agend|reserv|cita|disponib/.test(t)) return "agenda";
  if (/respond|respuesta|contest/.test(t)) return "silencio";
  return undefined;
}

/** Fallos del probador o del proveedor de IA: no es culpa de las instrucciones del cliente. */
function isTechnical(reason: string): boolean {
  return /error|timeout|429|500|proveedor|cr[eé]dito|token|sin versi[oó]n|falla/i.test(reason);
}

export function classifyQaFailure(name: string, reason?: string): QaFailureKind {
  const r = (reason ?? "").trim();
  if (r && isTechnical(r)) return "tecnico";
  return kindFrom(r) ?? kindFrom(name) ?? "tecnico";
}

/** Convierte los escenarios fallidos en problemas explicados, sin repetir el mismo consejo. */
export function explainQaResults(results: { name: string; pass: boolean; reason?: string }[]): QaProblem[] {
  const out: QaProblem[] = [];
  const seen = new Set<QaFailureKind>();
  for (const r of results) {
    if (r.pass) continue;
    const kind = classifyQaFailure(r.name, r.reason);
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push({ escenario: r.name, kind, ...COPY[kind] });
  }
  return out;
}

/** Titular de una línea para mostrar arriba del resultado. */
export function qaHeadline(r: { passed: boolean; published: boolean; corrected: boolean }, problemas: number): string {
  if (r.passed && r.published) {
    return r.corrected
      ? "Tu asistente pasó todas las pruebas y ya está publicado. Afinamos un par de instrucciones para que responda mejor."
      : "Tu asistente pasó todas las pruebas y ya está publicado: desde ahora responde en tu WhatsApp.";
  }
  if (r.passed) return "Tu asistente pasó todas las pruebas y ya estaba publicado: no había nada nuevo por publicar.";
  return problemas === 1
    ? "Todavía no publicamos tu asistente: encontramos 1 cosa por corregir."
    : `Todavía no publicamos tu asistente: encontramos ${problemas} cosas por corregir.`;
}
