/**
 * ETAPA 4 — a qué calendario sugerirle cada profesional en el asistente de 1 paso.
 *
 * El asistente tiene que resolver el caso normal SIN preguntar nada: una barbería de 3
 * barberos no debería tener que entender qué es un calendario para empezar a usar esto. Si
 * la sugerencia es buena, el dueño solo aprieta "Activar sincronización".
 *
 * Puro a propósito: es la única parte con criterio de toda la pantalla.
 */

export interface CalendarOption {
  id: string;
  name: string;
  primary: boolean;
}

/** Normaliza para comparar: sin tildes, sin mayúsculas, sin puntuación. */
export function normalizar(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Las "palabras con contenido" de un nombre (se van los títulos y las partículas). */
function palabras(nombre: string): string[] {
  const RUIDO = new Set(["dr", "dra", "don", "dona", "sr", "sra", "de", "del", "la", "el", "los", "las", "y"]);
  return normalizar(nombre)
    .split(" ")
    .filter((p) => p.length > 2 && !RUIDO.has(p));
}

/**
 * Calendario sugerido para un profesional.
 *
 * Orden: (1) coincidencia por nombre o por correo con un calendario de la lista; (2) el
 * principal. Nunca devuelve un calendario ya tomado por otro profesional: dos barberos en el
 * mismo calendario es precisamente lo que esta etapa viene a resolver — salvo el principal,
 * que es el respaldo razonable cuando no hay nada mejor.
 */
export function sugerirCalendario(
  pro: { id: string; name: string; email?: string | null },
  opciones: CalendarOption[],
  yaTomados: Set<string> = new Set(),
): string {
  if (!opciones.length) return "";
  const libres = opciones.filter((c) => !yaTomados.has(c.id));

  // 1) Por correo exacto: el id del calendario de una persona ES su correo.
  if (pro.email) {
    const porCorreo = libres.find((c) => normalizar(c.id) === normalizar(pro.email ?? ""));
    if (porCorreo) return porCorreo.id;
  }

  // 2) Por nombre: alguna palabra con contenido del profesional aparece en el calendario
  //    (nombre o correo). "Dra. Ana Pérez" ↔ "Ana Pérez" / "ana.perez@gmail.com".
  const ps = palabras(pro.name);
  if (ps.length) {
    const porNombre = libres.find((c) => {
      const texto = `${normalizar(c.name)} ${normalizar(c.id)}`;
      return ps.some((p) => texto.includes(p));
    });
    if (porNombre) return porNombre.id;
  }

  // 3) El principal como respaldo (aunque esté tomado: es el calendario del negocio).
  return opciones.find((c) => c.primary)?.id ?? "";
}

/**
 * Sugerencias para TODO el equipo, sin repetir calendarios (salvo el principal).
 *
 * Con un solo profesional se le asigna el principal directo, que es el caso de la mayoría
 * de los clientes y el que el asistente resuelve sin preguntar.
 */
export function sugerirParaEquipo(
  pros: Array<{ id: string; name: string; email?: string | null }>,
  opciones: CalendarOption[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const tomados = new Set<string>();
  const principal = opciones.find((c) => c.primary)?.id ?? "";
  for (const pro of pros) {
    const sugerido = sugerirCalendario(pro, opciones, tomados);
    out[pro.id] = sugerido;
    if (sugerido && sugerido !== principal) tomados.add(sugerido);
  }
  return out;
}
