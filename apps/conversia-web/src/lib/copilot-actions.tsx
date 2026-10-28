"use client";
import { Fragment, type ReactNode } from "react";
import { parseBlocks, type InlineToken } from "./copilot-markdown";

/**
 * COP 1 — lo que la UI hace con las ACCIONES del copiloto, y el renderizado del markdown
 * simple de sus mensajes.
 *
 * Las acciones llegan YA validadas por el servidor (`apps/api/src/assistant/actions.ts`:
 * rutas de una lista blanca, `data-copilot` conocidos, enlaces https). Acá no se vuelve a
 * validar nada: se ejecuta. Lo único que sí es responsabilidad de esta capa es no romper la
 * página si un elemento a resaltar no está montado.
 */

export type AssistantAction =
  | { type: "navigate"; to: string }
  | { type: "highlight"; target: string; text: string }
  | { type: "button"; label: string; kind: "whatsapp" | "pago" | "interno" | "externo"; payload?: string }
  | { type: "checklist_refresh" }
  | { type: "celebrate"; step: string };

/** ¿El usuario pidió menos movimiento? Entonces nada de animaciones del copiloto. */
export function prefiereMenosMovimiento(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Resalta un elemento marcado con `data-copilot="<id>"`: lo trae a la vista y le pone un
 * anillo con el color de acento unos segundos.
 *
 * Devuelve false si el elemento NO está en la pantalla actual. Eso pasa de verdad: el
 * copiloto navega y resalta en el mismo turno, y la pantalla nueva tarda en montarse. Quien
 * llama usa ese false para reintentar una vez, en vez de perder el resaltado.
 */
export function resaltar(target: string, text: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-copilot="${CSS.escape(target)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: prefiereMenosMovimiento() ? "auto" : "smooth", block: "center" });
  el.classList.add("cv-copilot-mark");
  // El globo explicativo se anuncia a los lectores de pantalla: el resaltado visual solo
  // no le sirve a quien navega con teclado o lector.
  const globo = document.createElement("div");
  globo.className = "cv-copilot-tip";
  globo.setAttribute("role", "status");
  globo.textContent = text;
  el.prepend(globo);
  window.setTimeout(() => {
    el.classList.remove("cv-copilot-mark");
    globo.remove();
  }, 7000);
  return true;
}

/** Celebración corta de un paso completado (respeta `prefers-reduced-motion`). */
export function celebrar(): void {
  if (prefiereMenosMovimiento()) return;
  const el = document.createElement("div");
  el.className = "cv-copilot-celebrate";
  el.setAttribute("aria-hidden", "true");
  el.textContent = "🎉";
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 1600);
}

/** Estilos de las acciones. Van inline (la CSP del panel no admite hojas externas). */
export const COPILOT_ACTION_CSS = `
.cv-copilot-mark { position: relative; outline: 2px solid var(--acc); outline-offset: 4px; border-radius: 14px; transition: outline-color .2s ease; }
.cv-copilot-tip { position: absolute; top: -12px; left: 12px; right: 12px; z-index: 5; background: var(--acc); color: var(--acc-ink); font-size: 12.5px; line-height: 1.35; padding: 7px 11px; border-radius: 10px; box-shadow: 0 6px 18px rgba(0,0,0,.28); }
.cv-copilot-celebrate { position: fixed; left: 50%; top: 38%; transform: translate(-50%,-50%); font-size: 54px; z-index: 80; pointer-events: none; animation: cvcel 1.6s ease-out forwards; }
@keyframes cvcel { 0% { opacity: 0; transform: translate(-50%,-30%) scale(.6); } 25% { opacity: 1; transform: translate(-50%,-50%) scale(1.1); } 100% { opacity: 0; transform: translate(-50%,-80%) scale(1); } }
@media (prefers-reduced-motion: reduce) { .cv-copilot-celebrate { animation: none; display: none; } .cv-copilot-mark { transition: none; } }
`;

// ---------------------------------------------------------------------------
// Markdown simple
// ---------------------------------------------------------------------------

/**
 * Convierte los tokens de `copilot-markdown.ts` en nodos de React. El parseo —la parte que
 * decide qué se vuelve énfasis o enlace a partir de texto de un modelo— vive allá, puro y
 * con tests. Acá solo se dibuja, y SIN `dangerouslySetInnerHTML`.
 */
export function renderMarkdown(text: string): ReactNode {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        if (b.kind === "space") return <div key={i} style={{ height: 6 }} />;
        if (b.kind === "list") {
          return (
            <ul key={i} style={{ margin: "4px 0", paddingLeft: 18 }}>
              {b.items.map((tokens, j) => (
                <li key={j} style={{ margin: "2px 0" }}>{tokens.map(renderToken)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} style={{ margin: "3px 0" }}>
            {b.tokens.map(renderToken)}
          </p>
        );
      })}
    </>
  );
}

function renderToken(t: InlineToken, i: number): ReactNode {
  if (t.kind === "bold") return <strong key={i}>{t.text}</strong>;
  if (t.kind === "code") {
    return (
      <code key={i} style={{ fontSize: "0.92em", background: "var(--bg-tint)", padding: "1px 4px", borderRadius: 5 }}>
        {t.text}
      </code>
    );
  }
  if (t.kind === "link") return <a key={i} href={t.href} className="text-accent">{t.text}</a>;
  return <Fragment key={i}>{t.text}</Fragment>;
}
