/**
 * Pluralización en español para textos de la interfaz (B8): «1 contacto» / «3
 * contactos», con el número incluido. Evita los «(s)» perezosos.
 */
export function plural(n: number, singular: string, plural?: string): string {
  const word = n === 1 ? singular : (plural ?? `${singular}s`);
  return `${n.toLocaleString("es-CL")} ${word}`;
}
