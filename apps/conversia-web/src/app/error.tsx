"use client";

import { useEffect } from "react";

/**
 * §10.3 / §10.5 — Pantalla de error propia.
 *
 * Sin un `error.tsx`, cuando una pantalla revienta en el cliente Next muestra su pantalla
 * por defecto: en inglés y, según el caso, con el stack a la vista. Para el dueño de un
 * negocio eso parece que se cayó todo y que algo se perdió.
 *
 * Tres decisiones:
 *  - NO se muestra el mensaje técnico. Puede traer rutas internas o datos del tenant, y de
 *    todos modos no le sirve a quien lo lee. Va a la consola, donde lo ve el equipo.
 *  - Se ofrece REINTENTAR (`reset()` vuelve a montar el árbol), que resuelve la mayoría de
 *    los fallos transitorios sin recargar.
 *  - Se dice explícitamente que no se perdió nada, que es la primera pregunta real.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Al log del navegador (no a la pantalla): el `digest` permite cruzarlo con el servidor.
    console.error("Error de pantalla:", error?.digest ?? "", error);
  }, [error]);

  const boton: React.CSSProperties = {
    padding: "11px 18px",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--line)",
    background: "var(--surface-solid)",
    color: "var(--ink)",
    textDecoration: "none",
    display: "inline-block",
  };

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 440, padding: 28, textAlign: "center" }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 10px" }}>
          Algo se <span className="display-italic">rompió</span> en esta pantalla
        </h1>
        <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 6px" }}>
          No se perdió nada: tus conversaciones, contactos y citas están guardados. Falló solo lo que estabas viendo.
        </p>
        <p className="text-dim" style={{ fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
          Prueba de nuevo. Si se repite, escríbenos por Soporte y lo revisamos.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={reset}
            style={{ ...boton, background: "var(--acc)", color: "var(--acc-ink)", border: "1px solid transparent" }}
          >
            Probar de nuevo
          </button>
          <a href="/inicio" style={boton}>
            Ir a mi inicio
          </a>
        </div>
      </div>
    </main>
  );
}
