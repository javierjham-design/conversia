import type { ReactNode } from "react";

/**
 * DATOS LEGALES DE LA EMPRESA — EDITA SOLO ESTE BLOQUE.
 *
 * Razón social, RUT, domicilio y comuna de jurisdicción están COMPLETOS (los cargó el
 * dueño en el PR #547): ya no queda ningún campo entre [corchetes] por rellenar. Si
 * cambia alguno, edítalo acá y sube `actualizado`.
 *
 * Los textos de Términos y Privacidad son un punto de partida profesional, no asesoría
 * legal: conviene que un abogado los revise antes de la campaña pública (§10.4).
 */
export const LEGAL = {
  marca: "Conversia",
  razonSocial: "Sociedad de Inversiones H y A SpA",
  rut: "77.145.971-4",
  domicilio: "Manuel Montt 820, oficina 21, Temuco, Región de La Araucanía, Chile",
  comunaJurisdiccion: "Temuco",
  sitio: "conversia.cl",
  emailContacto: "contacto@conversia.cl",
  emailPrivacidad: "privacidad@conversia.cl",
  // Fecha de última actualización (YYYY-MM-DD). Súbela cuando edites los textos.
  actualizado: "2026-10-27",
};

function fechaLarga(iso: string): string {
  try {
    return new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T12:00:00`));
  } catch {
    return iso;
  }
}

/** Marco común de las páginas legales (público, sin login). Diseño Nocturna. */
export function LegalShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ minHeight: "100dvh", padding: "clamp(20px, 5vw, 48px) 20px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <a href="/crear" className="display" style={{ fontSize: 20, textDecoration: "none", color: "var(--acc-deep)" }}>{LEGAL.marca}</a>
          <span className="text-dim" style={{ fontSize: 13, marginLeft: "auto" }}>
            <a href="/legal/terminos" className="text-dim" style={{ textDecoration: "none" }}>Términos</a>
            {" · "}
            <a href="/legal/privacidad" className="text-dim" style={{ textDecoration: "none" }}>Privacidad</a>
          </span>
        </header>
        <h1 className="display" style={{ fontSize: "clamp(26px, 5vw, 34px)", margin: "0 0 6px" }}>{title}</h1>
        <p className="text-dim" style={{ fontSize: 13, margin: "0 0 28px" }}>Última actualización: {fechaLarga(LEGAL.actualizado)}</p>
        <article className="legal-body">{children}</article>
        <footer style={{ marginTop: 40, paddingTop: 20, borderTop: "1px solid var(--hairline)", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
          <a href="/crear" className="text-accent" style={{ textDecoration: "none" }}>Crear mi asistente</a>
          <a href="/login" className="text-dim" style={{ textDecoration: "none" }}>Entrar</a>
          <span className="text-dim" style={{ marginLeft: "auto" }}>© {new Date().getFullYear()} {LEGAL.marca}</span>
        </footer>
      </div>
      {/* Tipografía de lectura para los textos legales (hereda tokens Nocturna). */}
      <style>{`
        .legal-body { color: var(--ink); font-size: 15px; line-height: 1.7; }
        .legal-body h2 { font-size: 18px; margin: 28px 0 8px; }
        .legal-body h3 { font-size: 15px; margin: 18px 0 6px; }
        .legal-body p, .legal-body li { color: var(--ink-dim); }
        .legal-body ul { padding-left: 20px; margin: 8px 0; }
        .legal-body li { margin: 4px 0; }
        .legal-body a { color: var(--acc-deep); }
        .legal-body strong { color: var(--ink); }
      `}</style>
    </main>
  );
}
