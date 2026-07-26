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
  const noControl = Array.from(value ?? "")
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join("");
  return noControl
    .replace(/[<>{}]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 120);
}
