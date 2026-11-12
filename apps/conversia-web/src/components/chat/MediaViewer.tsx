"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaBlob } from "../../lib/media-blob";
import { createPortal } from "react-dom";

/**
 * VISOR DE IMÁGENES — componente propio, sin librería.
 *
 * Decisión del dueño: sin dependencia nueva. Y es razonable — lo que hace falta acá es
 * pantalla completa, zoom, arrastre y pasar de una foto a otra. Una librería de lightbox trae
 * además galerías, miniaturas, vídeo, subtítulos y su propio sistema de temas, y después hay
 * que pelearle el estilo para que se parezca al resto del panel.
 *
 * Va por `portal` al `body`: dentro del árbol de la bandeja quedaría por debajo del header
 * sticky y del riel de navegación, por mucho z-index que se le ponga.
 */

export interface FotoDelVisor {
  id: string;
  /**
   * RUTA del endpoint, no un blob ya descargado.
   *
   * Al principio el visor recibía blobs: solo podía mostrar las fotos que la pantalla ya
   * había bajado. En móvil eso lo rompía — las miniaturas usan `loading="lazy"`, así que las
   * de más abajo no estaban descargadas y las flechas se quedaban sin a dónde ir. Con la ruta,
   * el visor baja la que muestra; `useMediaBlob` cachea, así que una ya vista aparece al
   * instante y ninguna se baja dos veces.
   */
  ruta: string | null;
  caption?: string | null;
}

const ZOOMS = [1, 2, 4];

export function MediaViewer({
  fotos,
  indiceInicial,
  onCerrar,
}: {
  fotos: FotoDelVisor[];
  indiceInicial: number;
  onCerrar: () => void;
}) {
  const [i, setI] = useState(indiceInicial);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const arrastre = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pellizco = useRef<number | null>(null);
  const [montado, setMontado] = useState(false);

  useEffect(() => setMontado(true), []);

  const foto = fotos[i];
  const { estado, url } = useMediaBlob(foto?.ruta ?? null);
  const reset = useCallback(() => {
    setZoom(1);
    setPos({ x: 0, y: 0 });
  }, []);

  const ir = useCallback(
    (delta: number) => {
      setI((prev) => {
        const sig = prev + delta;
        if (sig < 0 || sig >= fotos.length) return prev;
        return sig;
      });
      reset();
    },
    [fotos.length, reset],
  );

  // Teclado: Esc cierra, flechas pasan. Sin esto hay que ir al ratón para todo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
      else if (e.key === "ArrowRight") ir(1);
      else if (e.key === "ArrowLeft") ir(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => ZOOMS[Math.min(ZOOMS.indexOf(z) + 1, ZOOMS.length - 1)] ?? z);
      else if (e.key === "-") setZoom((z) => ZOOMS[Math.max(ZOOMS.indexOf(z) - 1, 0)] ?? z);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ir, onCerrar]);

  // Bloquear el scroll del fondo: si no, la rueda mueve el hilo DETRÁS del visor.
  useEffect(() => {
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, []);

  if (!montado || !foto) return null;

  const descargar = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `foto-${i + 1}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const contenido = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Foto ${i + 1} de ${fotos.length}`}
      data-testid="visor"
      onClick={(e) => {
        // Clic en el FONDO cierra; clic en la imagen o en un botón, no.
        if (e.target === e.currentTarget) onCerrar();
      }}
      onWheel={(e) => {
        const dir = e.deltaY < 0 ? 1 : -1;
        setZoom((z) => {
          const idx = Math.min(Math.max(ZOOMS.indexOf(z) + dir, 0), ZOOMS.length - 1);
          const next = ZOOMS[idx] ?? z;
          if (next === 1) setPos({ x: 0, y: 0 });
          return next;
        });
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.9)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
        overscrollBehavior: "contain",
      }}
    >
      {/* Barra superior: contador y acciones. */}
      {/* z-index explícito: en móvil la imagen ocupa TODO el ancho y, al ir después en el
          DOM, se pinta encima y se come los clics de la barra y de las flechas. En escritorio
          no se notaba porque la foto queda contenida y deja los bordes libres. */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", color: "#fff", gap: 10 }}>
        <span data-testid="visor-contador" style={{ fontSize: 13, opacity: 0.85 }}>
          {fotos.length > 1 ? `${i + 1} / ${fotos.length}` : ""}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={descargar} aria-label="Descargar foto" style={botonBarra}>Descargar</button>
          <button onClick={onCerrar} aria-label="Cerrar" data-testid="visor-cerrar" style={{ ...botonBarra, fontSize: 18, lineHeight: 1, padding: "6px 12px" }}>✕</button>
        </div>
      </div>

      {fotos.length > 1 ? (
        <>
          <button onClick={() => ir(-1)} aria-label="Foto anterior" data-testid="visor-anterior" disabled={i === 0} style={{ ...flecha, left: 10, opacity: i === 0 ? 0.3 : 0.9 }}>‹</button>
          <button onClick={() => ir(1)} aria-label="Foto siguiente" data-testid="visor-siguiente" disabled={i === fotos.length - 1} style={{ ...flecha, right: 10, opacity: i === fotos.length - 1 ? 0.3 : 0.9 }}>›</button>
        </>
      ) : null}

      {!url ? (
        <span style={{ color: "#fff", fontSize: 13, opacity: 0.8 }} data-testid="visor-cargando">
          {estado === "expired" ? "Este archivo ya no está disponible." : estado === "error" ? "No se pudo cargar" : "Cargando…"}
        </span>
      ) : null}
      <img
        src={url ?? ""}
        hidden={!url}
        alt={foto.caption ?? `Foto ${i + 1}`}
        data-testid="visor-imagen"
        draggable={false}
        onDoubleClick={() => {
          setZoom((z) => {
            const next = ZOOMS[(ZOOMS.indexOf(z) + 1) % ZOOMS.length];
            if (next === 1) setPos({ x: 0, y: 0 });
            return next;
          });
        }}
        onPointerDown={(e) => {
          if (zoom === 1) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          arrastre.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
        }}
        onPointerMove={(e) => {
          if (!arrastre.current) return;
          setPos({ x: arrastre.current.px + (e.clientX - arrastre.current.x), y: arrastre.current.py + (e.clientY - arrastre.current.y) });
        }}
        onPointerUp={() => {
          arrastre.current = null;
        }}
        onTouchStart={(e) => {
          if (e.touches.length === 2) pellizco.current = distancia(e.touches);
        }}
        onTouchMove={(e) => {
          if (e.touches.length !== 2 || pellizco.current === null) return;
          const d = distancia(e.touches);
          if (d > pellizco.current * 1.2) {
            setZoom((z) => ZOOMS[Math.min(ZOOMS.indexOf(z) + 1, ZOOMS.length - 1)] ?? z);
            pellizco.current = d;
          } else if (d < pellizco.current * 0.8) {
            setZoom((z) => {
              const next = ZOOMS[Math.max(ZOOMS.indexOf(z) - 1, 0)] ?? z;
              if (next === 1) setPos({ x: 0, y: 0 });
              return next;
            });
            pellizco.current = d;
          }
        }}
        onTouchEnd={() => {
          pellizco.current = null;
        }}
        style={{
          maxWidth: "100vw",
          maxHeight: "100vh",
          objectFit: "contain",
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})`,
          transition: arrastre.current ? "none" : "transform .12s ease-out",
          cursor: zoom > 1 ? "grab" : "zoom-in",
          userSelect: "none",
        }}
      />

      {foto.caption ? (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "14px 18px", color: "#fff", fontSize: 13, textAlign: "center", background: "linear-gradient(transparent, rgba(0,0,0,.6))" }}>
          {foto.caption}
        </div>
      ) : null}
    </div>
  );

  return createPortal(contenido, document.body);
}

function distancia(t: React.TouchList): number {
  const [a, b] = [t[0], t[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

const botonBarra: React.CSSProperties = {
  background: "rgba(255,255,255,.14)",
  color: "#fff",
  border: "none",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};

const flecha: React.CSSProperties = {
  position: "absolute",
  zIndex: 2,
  top: "50%",
  transform: "translateY(-50%)",
  background: "rgba(255,255,255,.14)",
  color: "#fff",
  border: "none",
  borderRadius: "50%",
  width: 44,
  height: 44,
  fontSize: 28,
  lineHeight: 1,
  cursor: "pointer",
};
