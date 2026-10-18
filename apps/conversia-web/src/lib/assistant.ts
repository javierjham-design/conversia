/**
 * Abre el Asistente Conversia (la burbuja del Bloque B) con un contexto opcional.
 *
 * Usa un "handshake" con un evento CANCELABLE: si la burbuja está montada y la cuenta es
 * elegible, su listener llama `preventDefault()` y el evento queda "tomado" → no hacemos nada
 * más. Si NADIE lo toma (p. ej. una cuenta de otra marca que entró por error a conversia-web y
 * no tiene asistente), caemos a un enlace de soporte, para que el dueño nunca se quede sin salida
 * ni vea un error crudo. Así el botón "Pedir ayuda al asistente" siempre hace algo útil.
 */
export function openAssistant(detail?: { topic?: string; context?: string }): void {
  let handled = false;
  try {
    const ev = new CustomEvent("conversia:assistant:open", { detail: detail ?? {}, cancelable: true });
    // dispatchEvent devuelve false si algún listener llamó preventDefault() = la burbuja lo tomó.
    handled = window.dispatchEvent(ev) === false;
  } catch {
    /* noop */
  }
  if (handled) return;

  // Fallback: no hay asistente disponible en esta cuenta → enlace de soporte humano.
  const wa = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
  const msg = detail?.context
    ? `Hola, necesito ayuda: ${detail.context}`
    : "Hola, vengo del panel de Conversia y necesito ayuda";
  const url = wa
    ? `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`
    : `mailto:soporte@conversia.cl?subject=${encodeURIComponent("Ayuda · panel Conversia")}&body=${encodeURIComponent(msg)}`;
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    /* noop */
  }
}
