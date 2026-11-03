"use client";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    setMontado(true);
    setVisible(estadoConsentimiento() === "sin-respuesta");
  }, []);

  // Si el visitante navega a otra ruta de marketing sin haber contestado, el aviso sigue.
  useEffect(() => {
    if (montado) setVisible(estadoConsentimiento() === "sin-respuesta");
  }, [pathname, montado]);

  if (!montado || !visible) return null;
  if (!pathname || !esRutaDeMarketing(pathname)) return null;

  const decidir = (valor: "aceptado" | "solo-necesarias") => {
    guardarConsentimiento(valor);
    // Quien rechaza DESPUÉS de haber aceptado deja `_fbp`/`_fbc`/`cv_attr` vivas: seguirían
    // identificando el navegador con el permiso retirado.
    if (valor === "solo-necesarias") borrarCookiesDeMedicion();
    setVisible(false);
  };

  return (
    <>
      <div className="cv-cookies" role="dialog" aria-live="polite" aria-label="Preferencias de cookies">
        <div className="cv-cookies-txt">
          <strong>Cookies para medir nuestra publicidad.</strong> Las necesarias para que el sitio funcione van siempre. Las de
          medición (Pixel de Meta) solo si las aceptas, y sirven para saber qué anuncio te trajo.{" "}
          <a href="/legal/privacidad#cookies">Cómo las usamos</a>.
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
.cv-cookies { position: fixed; z-index: 60; left: 16px; right: 16px; bottom: 16px; margin: 0 auto; max-width: 720px;
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
   quedan al alcance del pulgar, en vez de apretados contra el texto. */
@media (max-width: 560px) {
  .cv-cookies { gap: 12px; }
  .cv-cookies-btns { width: 100%; }
  .cv-cookies button { flex: 1; }
}
      `}</style>
    </>
  );
}
