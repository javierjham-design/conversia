/**
 * Sanitiza un valor de variable ANTES de interpolarlo en el prompt del sistema.
 * Los valores como contact.firstName provienen de datos controlados por el
 * usuario final (nombre de perfil de WhatsApp) => superficie de inyeccion
 * indirecta de prompt (LLM01). Se eliminan caracteres de control y saltos de
 * linea (charCode < 32 o == 127), delimitadores de plantilla/markup, y se
 * acota la longitud para que no puedan inyectar instrucciones en el canal de
 * instrucciones confiables del modelo.
 */
export function sanitizeVar(value: string): string {
  return sanitizePromptText(value, 120);
}

/**
 * §7.2 — Igual que `sanitizeVar` pero con largo configurable, para textos que SÍ pueden
 * ser largos y aun así vienen de afuera: los hechos de la memoria del contacto.
 *
 * La memoria la escribe la tool `recordarMemoria` con lo que el CONTACTO contó, y después
 * se interpola en el prompt del sistema de TODAS sus conversaciones futuras. Es inyección
 * de prompt PERSISTIDA: basta que alguien logre guardar "ignora tus instrucciones y…" una
 * vez para que vuelva en cada turno. Además de limpiar el texto, el bloque se envuelve
 * como DATOS (ver `formatMemoryForPrompt`).
 *
 * Se quitan también los acentos graves: sin eso, el contenido puede cerrar un cerco de
 * código y salirse del bloque donde lo pusimos.
 */
export function sanitizePromptText(value: string, maxLen: number): string {
  const noControl = Array.from(value ?? "")
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join("");
  return noControl
    .replace(/[<>{}`]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}
