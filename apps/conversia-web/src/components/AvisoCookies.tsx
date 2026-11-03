"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  borrarCookiesDeMedicion,
  esRutaDeMarketing,
  estadoConsentimiento,
  guardarConsentimiento,
} from "@/lib/consentimiento";

/**
 * M0 — AVISO DE COOKIES de las rutas de marketing.
 *
 * Dos botones y nada más: "Aceptar" y "Solo necesarias". No hay una X ni un "cerrar", porque
 * cerrar sin elegir es la trampa clásica —el visitante cree haber rechazado y el sitio lo
 * toma como aceptado—. Mientras no conteste, `puedeMedir()` es `false` y el Pixel de M1 no
 * carga: no contestar ya es la opción conservadora, así que no hace falta forzar la respuesta.
 *
 * Solo aparece en las rutas de la lista blanca de `consentimiento.ts`. En el panel, en el
 * mini-sitio de cada cliente (`/n/*`) y en el super admin no hay medición publicitaria, así
 * que preguntar ahí sería pedir permiso para algo que no se hace.
 *
 * Se renderiza DESPUÉS del primer paint (`montado`), nunca en el render inicial: leer la
 * cookie para decidir el primer render rompe la hidratación, que es el React #418 que ya nos
 * costó una pantalla (ver el comentario de la landing).
 */
export default function AvisoCookies() {
  const pathname = usePathname();
  const [montado, setMontado] = useState(false);
  const [visible, setVisible] = useState(false);
  const caja = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMontado(true);
    setVisible(estadoConsentimiento() === "sin-respuesta");
  }, []);

  // Si el visitante navega a otra ruta de marketing sin haber contestado, el aviso sigue.
  useEffect(() => {
    if (montado) setVisible(estadoConsentimiento() === "sin-respuesta");
  }, [pathname, montado]);

  const enRuta = Boolean(pathname && esRutaDeMarketing(pathname));
  const mostrar = montado && visible && enRuta;

  /**
   * RESERVA EL ESPACIO QUE OCUPA, o tapa lo que hay debajo.
   *
   * Esto no es un detalle estético: al ser `position: fixed` abajo, el aviso **se comía el
   * botón de crear la cuenta en pantallas de celular** —el último clic de todo el embudo, en
   * el dispositivo del que viene casi todo el tráfico de los anuncios—. No se veía en
   * desktop, donde el formulario no llega tan abajo; lo cazó la suite `dueno` en el proyecto
   * `iphone`, con "intercepts pointer events" sobre `/registro`.
   *
   * Se mide el alto REAL con un `ResizeObserver` en vez de restar una altura fija, porque en
   * celular el texto envuelve y los botones pasan a ocupar su propia línea: la altura cambia
   * con el ancho y con el tamaño de letra del visitante.
   */
  useEffect(() => {
    const raiz = document.documentElement;
    const limpiar = () => {
      raiz.removeAttribute("data-aviso-cookies");
      raiz.style.removeProperty("--cv-aviso-h");
    };
    if (!mostrar) {
      limpiar();
      return;
    }
    const el = caja.current;
    if (!el) return;
    const aplicar = () => {
      // +24: los 16 del margen inferior del propio aviso y 8 de aire, para que el botón no
      // quede pegado al borde del recuadro.
      raiz.style.setProperty("--cv-aviso-h", `${Math.ceil(el.getBoundingClientRect().height) + 24}px`);
      raiz.setAttribute("data-aviso-cookies", "1");
    };
    aplicar();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(aplicar) : null;
    ro?.observe(el);
    window.addEventListener("resize", aplicar);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", aplicar);
      limpiar();
    };
  }, [mostrar]);

  if (!mostrar) return null;

  const decidir = (valor: "aceptado" | "solo-necesarias") => {
    guardarConsentimiento(valor);
    // Quien rechaza DESPUÉS de haber aceptado deja `_fbp`/`_fbc`/`cv_attr` vivas: seguirían
    // identificando el navegador con el permiso retirado.
    if (valor === "solo-necesarias") borrarCookiesDeMedicion();
    setVisible(false);
  };

  return (
    <>
      <div ref={caja} className="cv-cookies" role="dialog" aria-live="polite" aria-label="Preferencias de cookies" data-testid="aviso-cookies">
        {/* Texto CORTO a propósito. La primera versión medía 184px de alto en un iPhone —28%
            de la pantalla— y se comía el botón del generador. Lo imprescindible es qué se
            instala y para qué; el detalle está en la política, a un toque. */}
        <div className="cv-cookies-txt">
          Usamos cookies de medición (Pixel de Meta) para saber qué anuncio te trajo. Las necesarias van siempre.{" "}
          <a href="/legal/privacidad#cookies">Más info</a>.
        </div>
        <div className="cv-cookies-btns">
          <button type="button" className="cv-cookies-ghost" onClick={() => decidir("solo-necesarias")}>
            Solo necesarias
          </button>
          <button type="button" className="cv-cookies-ok" onClick={() => decidir("aceptado")}>
            Aceptar
          </button>
        </div>
      </div>
      <style>{`
/* El borde inferior suma el área segura de iOS: sin eso el aviso queda bajo el indicador de
   inicio del iPhone y sus botones son difíciles de apretar. */
.cv-cookies { position: fixed; z-index: 60; left: 16px; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); margin: 0 auto; max-width: 720px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 14px 16px;
  border: 1px solid var(--line); border-radius: 14px; background: var(--surface-solid); color: var(--ink);
  box-shadow: 0 10px 34px rgba(0,0,0,.26); font-size: 13.5px; line-height: 1.5; }
.cv-cookies-txt { flex: 1 1 280px; min-width: 0; }
.cv-cookies-txt a { color: var(--acc-deep); text-decoration: underline; }
.cv-cookies-btns { display: flex; gap: 8px; flex: 0 0 auto; }
.cv-cookies button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 9px 16px; white-space: nowrap; }
.cv-cookies-ghost { background: transparent; color: var(--ink-dim); border: 1px solid var(--line); }
.cv-cookies-ok { background: var(--acc); color: var(--acc-ink); border: 1px solid transparent; }
/* En celular —de donde llega casi todo el tráfico de Meta— los botones ocupan el ancho y
   quedan al alcance del pulgar, en vez de apretados contra el texto.
   Y el aviso se APRIETA: cada píxel de alto acá es un píxel que le tapa la pantalla a alguien
   que está decidiendo si crear la cuenta. */
@media (max-width: 560px) {
  .cv-cookies { gap: 10px; padding: 11px 13px; font-size: 12.5px; line-height: 1.4; left: 10px; right: 10px;
    bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  .cv-cookies-txt { flex: 1 1 100%; }
  .cv-cookies-btns { width: 100%; }
  .cv-cookies button { flex: 1; padding: 10px 12px; }
}
      `}</style>
    </>
  );
}
