import Link from "next/link";

/**
 * §10.3 — Página 404 propia.
 *
 * Sin esto, cualquier ruta inexistente mostraba la pantalla por defecto de Next: en inglés,
 * sin la marca y sin salida. Un cliente que llega por un enlace viejo o mal copiado se
 * quedaba en una pantalla que parece una caída del sistema.
 *
 * Usa los tokens del design system (Nocturna) para respetar claro/oscuro y el acento
 * elegido, igual que el resto del panel. Es un componente de servidor: sin JS.
 */
export default function NotFound() {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 420, padding: 28, textAlign: "center" }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 10px" }}>
          No encontramos <span className="display-italic">esta página</span>
        </h1>
        <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 20px" }}>
          El enlace puede estar roto o la página ya no existe. Tu cuenta y tus conversaciones están intactas.
        </p>
        <Link
          href="/inicio"
          style={{
            display: "inline-block",
            padding: "11px 18px",
            borderRadius: 12,
            background: "var(--acc)",
            color: "var(--acc-ink)",
            fontSize: 15,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Ir a mi inicio
        </Link>
      </div>
    </main>
  );
}
