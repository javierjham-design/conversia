"use client";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { ConviAvatar } from "@/components/ConviAvatar";
import { cartelDeConvi, textoDeProgreso, type ConviCtx } from "@/lib/convi";

/**
 * EL CARTEL DE CONVI EN LA PANTALLA "HOY".
 *
 * Convi vivía solo en una burbuja flotante de 56px con una carita y ni una palabra. Quien
 * entra por primera vez no tiene cómo saber que ahí hay alguien que le monta el negocio
 * conversando: es el mismo problema que tenía el menú con nueve iconos mudos.
 *
 * Por qué EN EL FLUJO y no más grande flotando: una barra fija abajo SIEMPRE tapa algo
 * (lo aprendimos con el aviso de la PWA tapando el menú entero en teléfono, y después
 * tapando el botón "Reintentar" del saldo). Acá, en la primera pantalla y empujando al
 * resto hacia abajo, Convi puede ser todo lo grande que haga falta sin quitarle el toque a
 * nadie. Ver `nada-tapa-la-barra.test.ts`.
 *
 * Solo en MODO MONTAJE: cuando el bot ya atiende, esta tarjeta desaparece sola y Convi
 * queda como el acceso de siempre. Nada que cerrar a mano, nada que vuelva a aparecer.
 */
export function ConviCartel() {
  const [ctx, setCtx] = useState<ConviCtx | null>(null);

  useEffect(() => {
    if (!getToken()) return;
    api<ConviCtx>("/assistant/context")
      .then(setCtx)
      .catch(() => {
        /* cuenta de otra marca o bache de red: el cartel simplemente no aparece */
      });
    // El copiloto avisa cuando movió el checklist: el cartel tiene que ir con él, si no
    // sigue diciendo "paso 2 de 7" después de que Convi completó el paso 2.
    function refrescar() {
      api<ConviCtx>("/assistant/context").then(setCtx).catch(() => undefined);
    }
    window.addEventListener("conversia:checklist:refresh", refrescar);
    return () => window.removeEventListener("conversia:checklist:refresh", refrescar);
  }, []);

  if (!ctx || ctx.mode !== "implementacion") return null;
  const cartel = cartelDeConvi(ctx);
  const pct = Math.max(0, Math.min(100, ctx.checklistPct));

  return (
    <div
      className="card cv-cartel"
      data-testid="convi-cartel"
      style={{ padding: 18, marginBottom: 18, borderColor: "var(--acc)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <ConviAvatar estado="saludando" size={84} pancarta />
        {/* 180 y no 220: en un teléfono de 390px, con el avatar al lado, 220 no cabe y el
            monito se iba a una línea para él solo, estirando la tarjeta media pantalla. */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <h2 className="display" style={{ fontSize: 19, margin: "0 0 3px" }}>{cartel.pancarta}</h2>
          <p className="text-dim" style={{ margin: 0, fontSize: 13.5 }}>{cartel.detalle}</p>
          {/* El avance con el MISMO texto que usa el panel de Convi: dos cuentas distintas
              del mismo montaje en la misma pantalla serían peor que no mostrar ninguna. */}
          {/* `wrap` + una base de 140px: en un teléfono la etiqueta no cabe al lado y, sin
              esto, la barra se comprimía a 30px (un avance que no se puede leer). Así la
              etiqueta baja a su propia línea y la barra se queda con el ancho entero. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Avance del montaje"
              style={{ flex: "1 1 140px", maxWidth: 260, height: 6, borderRadius: 999, background: "var(--bg-tint)", overflow: "hidden" }}
            >
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--acc)", transition: "width .4s ease" }} />
            </div>
            <span className="text-dim" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{textoDeProgreso(ctx)}</span>
          </div>
        </div>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("conversia:assistant:open"))}
          className="btn-accent"
          style={{ border: "none", cursor: "pointer", fontSize: 14, padding: "10px 18px", display: "inline-flex", alignItems: "center", gap: 7 }}
        >
          {cartel.cta} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
