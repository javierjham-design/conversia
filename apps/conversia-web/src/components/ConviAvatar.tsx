"use client";
import type { ConviEstado } from "@/lib/convi";

/**
 * COP 2 — el avatar de Convi, dibujado en SVG INLINE.
 *
 * Inline y no un archivo de imagen por la CSP del panel, que no admite hosts externos (y
 * para no sumar una petición en la primera entrada, que es justo cuando Convi aparece).
 * Todos los colores salen de los tokens de `globals.css`, así que funciona en tema claro y
 * oscuro y cambia con el acento que elija el dueño, sin una sola constante de color acá.
 *
 * Cinco estados, con la expresión como única diferencia real: saludando, pensando,
 * hablando, celebrando y preocupado (cuando algo falló). Las animaciones viven en un
 * `<style>` propio y TODAS se apagan con `prefers-reduced-motion`.
 */

export function ConviAvatar({
  estado = "saludando",
  size = 34,
  /** Anillo de progreso alrededor del avatar (0-100). `null` = sin anillo. */
  progreso = null,
  /**
   * Convi levanta un CARTEL. La pancarta de verdad —las palabras— va en HTML al lado del
   * avatar: un `<text>` dentro de este SVG mide 5px a tamaño de burbuja, no se lee, no lo
   * ve un lector de pantalla y no se puede cambiar sin tocar el dibujo. Acá se dibuja el
   * cartel vacío, que es lo que hace entender de un vistazo que el monito está AVISANDO
   * algo; lo que avisa lo dice `cartelDeConvi` en texto.
   *
   * Pensado para los tamaños grandes (≥48px). No se combina con `progreso`: el anillo y el
   * cartel se pelean el mismo borde — en la tarjeta el avance va en su propia barra.
   */
  pancarta = false,
  title,
}: {
  estado?: ConviEstado;
  size?: number;
  progreso?: number | null;
  pancarta?: boolean;
  title?: string;
}) {
  const r = 46;
  const circ = 2 * Math.PI * r;
  const pct = progreso == null ? null : Math.max(0, Math.min(100, progreso));

  return (
    <span
      className={`cv-convi cv-convi-${estado}${pancarta ? " cv-convi-con-cartel" : ""}`}
      style={{ display: "inline-grid", placeItems: "center", width: size, height: size, flexShrink: 0, lineHeight: 0 }}
      role="img"
      aria-label={title ?? `Convi, ${etiqueta(estado)}`}
    >
      <svg viewBox="0 0 110 110" width={size} height={size} aria-hidden="true">
        {/* Anillo de progreso del montaje (si se pide) */}
        {pct != null ? (
          <>
            <circle cx="55" cy="55" r={r} fill="none" stroke="var(--hairline)" strokeWidth="6" />
            <circle
              className="cv-convi-ring"
              cx="55"
              cy="55"
              r={r}
              fill="none"
              stroke="var(--acc)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - pct / 100)}
              transform="rotate(-90 55 55)"
            />
          </>
        ) : null}

        {/* EL CARTEL que Convi levanta. Va ANTES del cuerpo para que el palito quede por
            detrás, y el cuerpo se corre abajo-izquierda (`cv-convi-body` lo transforma) para
            hacerle sitio sin salirse del viewBox: con `overflow: visible` el dibujo se saldría
            de los 56px del acceso y se metería encima de lo que tenga al lado. */}
        {pancarta ? (
          <g className="cv-convi-sign">
            {/* El palito, de la "mano" al cartel */}
            <path d="M68 62 L82 38" stroke="var(--acc-deep)" strokeWidth="5" strokeLinecap="round" />
            <g transform="rotate(-9 88 22)">
              <rect x="58" y="4" width="50" height="33" rx="8" fill="var(--surface-solid)" stroke="var(--acc-deep)" strokeWidth="4" />
              {/* Dos renglones: a este tamaño leen como "acá dice algo", que es el punto. */}
              <path d="M68 16 h30" stroke="var(--acc-deep)" strokeWidth="4.5" strokeLinecap="round" opacity="0.9" />
              <path d="M68 26 h18" stroke="var(--acc-deep)" strokeWidth="4.5" strokeLinecap="round" opacity="0.55" />
            </g>
          </g>
        ) : null}

        {/* Cuerpo: una gota redondeada, con el color de acento.
            El encogido por el cartel va en un grupo APARTE y como atributo del SVG: si se
            pusiera como `transform` de CSS en `.cv-convi-body`, el saludo (que anima
            `transform`) lo pisaría y el monito volvería a su tamaño justo al saludar. */}
        <g transform={pancarta ? "translate(1 15) scale(0.76)" : undefined}>
        <g className="cv-convi-body">
          <circle cx="55" cy="55" r={pct != null ? 36 : 42} fill="var(--acc)" />
          {/* Reflejo, para que no se vea plano */}
          <ellipse cx="42" cy="40" rx={pct != null ? 11 : 13} ry={pct != null ? 8 : 9} fill="var(--acc-ink)" opacity="0.12" />

          {/* Ojos */}
          {estado === "celebrando" ? (
            // Ojos cerrados de alegría: dos arcos hacia arriba
            <>
              <path d="M40 54 q6 -7 12 0" stroke="var(--acc-ink)" strokeWidth="3.4" fill="none" strokeLinecap="round" />
              <path d="M58 54 q6 -7 12 0" stroke="var(--acc-ink)" strokeWidth="3.4" fill="none" strokeLinecap="round" />
            </>
          ) : estado === "preocupado" ? (
            <>
              <circle cx="46" cy="54" r="4" fill="var(--acc-ink)" />
              <circle cx="64" cy="54" r="4" fill="var(--acc-ink)" />
              {/* Cejas inclinadas hacia adentro */}
              <path d="M40 45 l11 4" stroke="var(--acc-ink)" strokeWidth="3" strokeLinecap="round" />
              <path d="M70 45 l-11 4" stroke="var(--acc-ink)" strokeWidth="3" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle className="cv-convi-eye" cx="46" cy="53" r="4.4" fill="var(--acc-ink)" />
              <circle className="cv-convi-eye" cx="64" cy="53" r="4.4" fill="var(--acc-ink)" />
            </>
          )}

          {/* Boca */}
          {estado === "preocupado" ? (
            <path d="M46 70 q9 -6 18 0" stroke="var(--acc-ink)" strokeWidth="3.2" fill="none" strokeLinecap="round" />
          ) : estado === "pensando" ? (
            <g className="cv-convi-dots">
              <circle cx="48" cy="69" r="2.6" fill="var(--acc-ink)" />
              <circle cx="55" cy="69" r="2.6" fill="var(--acc-ink)" />
              <circle cx="62" cy="69" r="2.6" fill="var(--acc-ink)" />
            </g>
          ) : estado === "hablando" ? (
            <ellipse className="cv-convi-mouth" cx="55" cy="68" rx="7" ry="5" fill="var(--acc-ink)" />
          ) : (
            <path d="M45 66 q10 9 20 0" stroke="var(--acc-ink)" strokeWidth="3.4" fill="none" strokeLinecap="round" />
          )}
        </g>
        </g>
      </svg>
      <style>{CONVI_CSS}</style>
    </span>
  );
}

function etiqueta(e: ConviEstado): string {
  switch (e) {
    case "pensando":
      return "pensando";
    case "hablando":
      return "respondiendo";
    case "celebrando":
      return "celebrando";
    case "preocupado":
      return "con un problema";
    default:
      return "tu copiloto";
  }
}

const CONVI_CSS = `
.cv-convi svg { overflow: visible; }
.cv-convi-ring { transition: stroke-dashoffset .5s ease; }
.cv-convi-saludando .cv-convi-body { animation: cvsaluda 2.4s ease-in-out 2; transform-origin: 55px 90px; }
.cv-convi-pensando .cv-convi-dots circle { animation: cvpiensa 1.2s ease-in-out infinite; }
.cv-convi-pensando .cv-convi-dots circle:nth-child(2) { animation-delay: .15s; }
.cv-convi-pensando .cv-convi-dots circle:nth-child(3) { animation-delay: .3s; }
.cv-convi-hablando .cv-convi-mouth { animation: cvhabla .45s ease-in-out infinite; transform-origin: 55px 68px; }
.cv-convi-celebrando .cv-convi-body { animation: cvcelebra .7s ease-out 2; transform-origin: 55px 90px; }
.cv-convi-preocupado .cv-convi-body { animation: cvpreocupa 1.6s ease-in-out 1; transform-origin: 55px 55px; }
/* El cartel se levanta despacio y no para: es lo que hace que el monito se NOTE sin tener
   que gritar con colores. Tres veces y se queda quieto, para no distraer eternamente. */
.cv-convi-con-cartel .cv-convi-sign { animation: cvcartel 2.6s ease-in-out 3; transform-origin: 70px 60px; }
@keyframes cvcartel { 0%,100% { transform: rotate(0deg); } 30% { transform: rotate(-6deg) translateY(-2px); } 60% { transform: rotate(3deg); } }
@keyframes cvsaluda { 0%,100% { transform: rotate(0deg); } 20% { transform: rotate(-7deg); } 40% { transform: rotate(7deg); } 60% { transform: rotate(-4deg); } }
@keyframes cvpiensa { 0%,100% { opacity: .3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2.5px); } }
@keyframes cvhabla { 0%,100% { transform: scaleY(.55); } 50% { transform: scaleY(1); } }
@keyframes cvcelebra { 0% { transform: translateY(0) scale(1); } 35% { transform: translateY(-7px) scale(1.06); } 100% { transform: translateY(0) scale(1); } }
@keyframes cvpreocupa { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-2px); } 75% { transform: translateX(2px); } }
@media (prefers-reduced-motion: reduce) {
  .cv-convi * { animation: none !important; transition: none !important; }
}
`;
