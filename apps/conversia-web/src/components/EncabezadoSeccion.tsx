import type { ReactNode } from "react";
import { pestanaActiva, seccionActiva } from "@/lib/nav";

/**
 * EL ENCABEZADO DE TODA PANTALLA DEL PANEL.
 *
 * Una pantalla no escribe su título: lo pide acá con su ruta y el título sale de la tabla de
 * navegación (`lib/nav.ts`). Así el texto del menú y el de la pantalla son, literalmente, el
 * mismo dato: no hay dos lugares donde escribirlo y por lo tanto no pueden divergir (que es
 * cómo el menú llegó a decir "Mi página" y la pantalla "Tu página web").
 *
 * Tres piezas, todas opcionales salvo el título:
 *  - **Pestañas**: cuando la sección tiene más de una pantalla (hoy, Agenda: Semana ·
 *    Configurar). Reemplazan la flecha de "volver", que obligaba a adivinar la jerarquía.
 *  - **Índice**: para pantallas largas (Cobros, Ajustes) — enlaces a las secciones de la
 *    MISMA página. A propósito NO son pestañas que esconden contenido: el copiloto Convi
 *    resalta elementos por `data-copilot` y si el elemento quedara en una pestaña cerrada
 *    Convi fallaría en silencio (su acción `navigate` solo acepta rutas exactas, sin query,
 *    ver `apps/api/src/assistant/actions.ts`). Nada se esconde; solo se puede saltar.
 *  - **Acciones**: el botón propio de la pantalla (Exportar CSV, Nueva cita…), a la derecha
 *    del título, donde se busca.
 */
export function EncabezadoSeccion({
  ruta,
  titulo,
  bajada,
  acciones,
  indice,
}: {
  /** La ruta ACTUAL. De ella salen el título, la bajada y la pestaña encendida. */
  ruta: string;
  /** Solo para la pantalla cuyo título no es el nombre de la sección (el saludo de Hoy). */
  titulo?: ReactNode;
  /** Pisa la bajada de la tabla. `null` la quita. */
  bajada?: ReactNode;
  acciones?: ReactNode;
  /** Enlaces a secciones de esta misma página: `{ id }` tiene que existir como `id` del DOM. */
  indice?: { id: string; label: string }[];
}) {
  const sec = seccionActiva(ruta);
  const activa = pestanaActiva(sec?.pestanas, ruta);
  const texto = titulo ?? sec?.label ?? "";
  const bajadaFinal = bajada === undefined ? sec?.bajada : bajada;

  return (
    <header className="encabezado">
      {/* Con título propio, el nombre de la sección va igual arriba: así "Hoy" también
          confirma a qué parte del menú entraste. */}
      {titulo && sec ? <p className="encabezado-ojo">{sec.label}</p> : null}

      <div className="encabezado-fila">
        <h1 className="display encabezado-titulo" suppressHydrationWarning>
          {texto}
        </h1>
        {acciones ? <div className="encabezado-acciones">{acciones}</div> : null}
      </div>

      {bajadaFinal ? <p className="text-dim encabezado-bajada">{bajadaFinal}</p> : null}

      {sec?.pestanas?.length ? (
        <nav className="pestanas" aria-label={`Pantallas de ${sec.label}`}>
          {sec.pestanas.map((p) => {
            const esta = p.href === activa?.href;
            return (
              <a key={p.href} href={p.href} className={esta ? "pestana activa" : "pestana"} aria-current={esta ? "page" : undefined}>
                {p.label}
              </a>
            );
          })}
        </nav>
      ) : null}

      {indice?.length ? (
        <nav className="indice" aria-label="En esta página">
          {indice.map((i) => (
            <a key={i.id} href={`#${i.id}`}>
              {i.label}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
