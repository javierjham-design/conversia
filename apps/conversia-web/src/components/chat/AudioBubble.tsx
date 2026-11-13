"use client";

import { useEffect, useRef, useState } from "react";
import type { MessageMedia } from "../../lib/message-media";
import { formatearDuracion } from "../../lib/chat-format";
import { olvidarReproduccion, registrarReproduccion, useMediaBlob } from "../../lib/media-blob";

/**
 * NOTA DE VOZ — reproductor propio, no `<audio controls>`.
 *
 * El control nativo se ve distinto en cada navegador, no respeta los colores del panel y en
 * móvil ocupa casi todo el ancho de la burbuja. Pero la razón de peso es otra: con el nativo
 * **no se puede mostrar la duración antes de descargar el archivo**, y descargar todas las
 * notas de voz de un hilo al abrirlo es gastar los datos del dueño en audios que quizá no va a
 * escuchar. Acá la duración viene de `media.durationSec` (la API la calcula, D2) y el archivo
 * se baja recién al pulsar play.
 *
 * Un solo audio suena a la vez, con un registro compartido: dos `<audio>` nativos sueltos se
 * pisan y quedan los dos sonando.
 */

const VELOCIDADES = [1, 1.5, 2];
const CLAVE_VELOCIDAD = "conversia:audio:velocidad";
const LARGO_TRANSCRIPCION_COLAPSADA = 160;

export function AudioBubble({ media, saliente }: { media: MessageMedia; saliente: boolean }) {
  const { estado, url, cargar } = useMediaBlob(media.url, { auto: false });
  const ref = useRef<HTMLAudioElement | null>(null);
  const [sonando, setSonando] = useState(false);
  const [actual, setActual] = useState(0);
  const [duracion, setDuracion] = useState<number | null>(media.durationSec ?? null);
  const [velocidad, setVelocidad] = useState(1);
  const [verTranscripcion, setVerTranscripcion] = useState(false);

  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(CLAVE_VELOCIDAD));
      if (VELOCIDADES.includes(v)) setVelocidad(v);
    } catch {
      /* almacenamiento bloqueado: se queda en 1x */
    }
  }, []);

  // Cuando el blob llega tras pulsar play, se reproduce solo: el dueño ya dijo que quería oírlo.
  useEffect(() => {
    const el = ref.current;
    if (!el || !url) return;
    el.playbackRate = velocidad;
    if (sonando) void el.play().catch(() => setSonando(false));
  }, [url, velocidad, sonando]);

  const alternar = () => {
    const el = ref.current;
    if (!url) {
      setSonando(true);
      cargar();
      return;
    }
    if (!el) return;
    if (el.paused) {
      registrarReproduccion(el);
      void el.play().catch(() => setSonando(false));
      setSonando(true);
    } else {
      el.pause();
      setSonando(false);
    }
  };

  const cambiarVelocidad = () => {
    const sig = VELOCIDADES[(VELOCIDADES.indexOf(velocidad) + 1) % VELOCIDADES.length];
    setVelocidad(sig);
    if (ref.current) ref.current.playbackRate = sig;
    try {
      localStorage.setItem(CLAVE_VELOCIDAD, String(sig));
    } catch {
      /* idem */
    }
  };

  if (estado === "expired") return <Expirado texto="🎤 Nota de voz" saliente={saliente} />;

  const total = duracion ?? media.durationSec ?? 0;
  const progreso = total > 0 ? Math.min(100, (actual / total) * 100) : 0;
  const transcripcion = media.transcript;
  const larga = (transcripcion?.length ?? 0) > LARGO_TRANSCRIPCION_COLAPSADA;

  return (
    <div data-testid="burbuja-audio" style={{ width: 260, maxWidth: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={alternar}
          aria-label={sonando ? "Pausar nota de voz" : "Reproducir nota de voz"}
          data-testid="audio-play"
          data-sonando={sonando ? "1" : "0"}
          style={{
            flex: "0 0 auto",
            width: 34,
            height: 34,
            borderRadius: "50%",
            border: "none",
            cursor: "pointer",
            background: saliente ? "rgba(255,255,255,.22)" : "var(--acc)",
            color: saliente ? "var(--acc-ink)" : "var(--acc-ink)",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          {estado === "loading" ? "…" : sonando ? "❚❚" : "▶"}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            type="range"
            min={0}
            max={Math.max(total, 0.1)}
            step={0.1}
            value={actual}
            aria-label="Avance de la nota de voz"
            onChange={(e) => {
              const v = Number(e.target.value);
              setActual(v);
              if (ref.current) ref.current.currentTime = v;
            }}
            style={{ width: "100%", accentColor: saliente ? "var(--acc-ink)" : "var(--acc)", height: 3 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, opacity: 0.85, marginTop: 1 }}>
            <span>{formatearDuracion(actual)}</span>
            <span data-testid="audio-duracion">{formatearDuracion(total)}</span>
          </div>
        </div>

        <button
          onClick={cambiarVelocidad}
          aria-label={`Velocidad ${velocidad}x`}
          style={{
            flex: "0 0 auto",
            border: "none",
            borderRadius: 999,
            padding: "2px 7px",
            fontSize: 10.5,
            cursor: "pointer",
            background: saliente ? "rgba(255,255,255,.2)" : "var(--hairline)",
            color: "inherit",
          }}
        >
          {velocidad}x
        </button>
      </div>

      {estado === "error" ? (
        <a href={media.url ?? "#"} style={{ fontSize: 11.5, opacity: 0.9 }}>Descargar audio</a>
      ) : null}

      {url ? (
        <audio
          ref={ref}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = (e.target as HTMLAudioElement).duration;
            if (Number.isFinite(d) && d > 0) setDuracion(d);
          }}
          onTimeUpdate={(e) => setActual((e.target as HTMLAudioElement).currentTime)}
          onEnded={() => {
            setSonando(false);
            setActual(0);
            if (ref.current) olvidarReproduccion(ref.current);
          }}
          onPause={() => setSonando(false)}
          style={{ display: "none" }}
        />
      ) : null}

      {transcripcion ? (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.92 }}>
          <button
            onClick={() => setVerTranscripcion((v) => !v)}
            data-testid="audio-transcripcion"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", fontSize: 11.5, opacity: 0.8 }}
          >
            {verTranscripcion || !larga ? "▾" : "▸"} Transcripción
          </button>
          {verTranscripcion || !larga ? (
            <p style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{transcripcion}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Burbuja gris para lo que Meta ya borró. Explica, no culpa, y conserva de qué era. */
export function Expirado({ texto, saliente }: { texto: string; saliente: boolean }) {
  return (
    <div
      data-testid="medio-expirado"
      style={{
        fontSize: 12.5,
        opacity: 0.75,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        color: saliente ? "inherit" : "var(--ink-dim)",
      }}
    >
      <span>{texto}</span>
      <span style={{ fontSize: 11 }}>Este archivo ya no está disponible.</span>
    </div>
  );
}
