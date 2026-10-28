/**
 * COP 1 — el markdown de los mensajes del copiloto, separado en DATOS.
 *
 * El texto lo escribe un modelo de lenguaje, así que el parseo es la parte que hay que
 * vigilar: qué se convierte en énfasis, qué en enlace y qué se queda como texto plano. Esa
 * decisión vive acá, pura y testeable; el componente solo convierte estos tokens en nodos
 * de React. Nada se vuelve HTML por el camino: no hay `dangerouslySetInnerHTML` en ninguno
 * de los dos lados, así que lo peor que puede hacer un mensaje raro es verse raro.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  /** Enlace INTERNO del panel. Un `href` externo nunca llega a ser un enlace (ver abajo). */
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph"; tokens: InlineToken[] }
  | { kind: "list"; items: InlineToken[][] }
  | { kind: "space" };

/**
 * `[texto](/ruta)` solo se convierte en enlace si la ruta es INTERNA y absoluta. Un
 * `[pincha acá](https://…)` o un `javascript:` se quedan como texto literal: el copiloto
 * tiene la acción `button` con `kind: "externo"` para abrir algo de fuera, y esa sí pasa
 * por la lista blanca del servidor. Aquí no hay forma de fabricar un enlace saliente.
 */
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
const RUTA_INTERNA = /^\/(?!\/)[A-Za-z0-9\-_/?=&.%]*$/;

export function parseInline(linea: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  const push = (t: InlineToken) => {
    if (t.kind === "text" && !t.text) return;
    out.push(t);
  };
  while ((m = INLINE.exec(linea))) {
    if (m.index > last) push({ kind: "text", text: linea.slice(last, m.index) });
    if (m[1] !== undefined) push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) push({ kind: "code", text: m[2] });
    else if (m[3] !== undefined) {
      const href = m[4] ?? "";
      if (RUTA_INTERNA.test(href)) push({ kind: "link", text: m[3], href });
      // Enlace no interno: se deja el markdown tal cual, como texto. El dueño ve que el
      // copiloto quiso enlazar algo y no se le ofrece un destino sin validar.
      else push({ kind: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < linea.length) push({ kind: "text", text: linea.slice(last) });
  return out;
}

/** Párrafos, listas con guion y líneas en blanco. Lo que el copiloto usa de verdad. */
export function parseBlocks(text: string): Block[] {
  const bloques: Block[] = [];
  let items: InlineToken[][] = [];
  const cerrarLista = () => {
    if (!items.length) return;
    bloques.push({ kind: "list", items });
    items = [];
  };
  for (const linea of text.split("\n")) {
    const item = /^\s*[-*•]\s+(.*)$/.exec(linea);
    if (item) {
      items.push(parseInline(item[1]));
      continue;
    }
    cerrarLista();
    if (!linea.trim()) {
      bloques.push({ kind: "space" });
      continue;
    }
    bloques.push({ kind: "paragraph", tokens: parseInline(linea) });
  }
  cerrarLista();
  return bloques;
}
