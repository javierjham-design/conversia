"use client";

import { useEffect, useState } from "react";
import type { MessageMedia } from "../../lib/message-media";
import { ICONO_DOCUMENTO, familiaDeMime, formatearTamaño } from "../../lib/chat-format";
import { useMediaBlob } from "../../lib/media-blob";
import { Expirado } from "./AudioBubble";

/**
 * Las burbujas de medio que no son audio. Cada una resuelve un problema distinto de la
 * bandeja de Conversia, que hasta ahora mostraba literalmente «[imagen]» para todas.
 */

/**
 * FOTO. El `aspect-ratio` reservado es lo que evita que el hilo SALTE mientras cargan las
 * miniaturas: sin él, cada imagen que termina de bajar empuja todo lo de abajo y el dueño
 * pierde el renglón que estaba leyendo.
 */
export function ImageBubble({
  media,
  onAbrir,
  onLista,
}: {
  media: MessageMedia;
  onAbrir?: (url: string) => void;
  /** Avisa el blob al hilo para que el visor pueda pasar entre todas las fotos. */
  onLista?: (url: string) => void;
}) {
  const { estado, url } = useMediaBlob(media.url);
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    if (url) onLista?.(url);
  }, [url, onLista]);

  if (estado === "expired") return <Expirado texto="📷 Foto" saliente={false} />;

  return (
    <figure style={{ margin: 0 }} data-testid="burbuja-imagen">
      <div
        style={{
          width: 280,
          maxWidth: "100%",
          aspectRatio: ratio ? String(ratio) : "4 / 3",
          maxHeight: 320,
          borderRadius: 12,
          overflow: "hidden",
          background: "var(--hairline)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: url ? "zoom-in" : "default",
        }}
        onClick={() => url && onAbrir?.(url)}
      >
        {url ? (
          <img
            src={url}
            alt={media.caption ?? "Foto"}
            loading="lazy"
            data-testid="imagen-miniatura"
            onLoad={(e) => {
              const el = e.target as HTMLImageElement;
              if (el.naturalWidth && el.naturalHeight) setRatio(el.naturalWidth / el.naturalHeight);
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span style={{ fontSize: 11.5, opacity: 0.7 }}>{estado === "error" ? "No se pudo cargar" : "Cargando…"}</span>
        )}
      </div>
      {media.caption ? (
        <figcaption style={{ fontSize: 13, marginTop: 4, lineHeight: 1.35 }}>{media.caption}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * STICKER. Sin burbuja ni borde a propósito: un sticker es un recorte con fondo transparente,
 * y meterlo dentro de un rectángulo de color lo convierte en una calcomanía pegada en un
 * cuadrado. Los webp animados se mueven solos en `<img>` en todos los navegadores actuales,
 * así que no hace falta nada especial para el animado.
 */
export function StickerBubble({ media }: { media: MessageMedia }) {
  const { estado, url } = useMediaBlob(media.url);
  if (estado === "expired") return <Expirado texto="Sticker" saliente={false} />;
  return (
    <div data-testid="burbuja-sticker" style={{ width: 140, height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {url ? (
        <img src={url} alt="Sticker" data-animado={media.animated ? "1" : "0"} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      ) : (
        <span style={{ fontSize: 11.5, opacity: 0.6 }}>…</span>
      )}
    </div>
  );
}

/** VIDEO. Se descarga al pulsar play: bajar un video que nadie va a ver es gastar datos. */
export function VideoBubble({ media }: { media: MessageMedia }) {
  const { estado, url, cargar } = useMediaBlob(media.url, { auto: false });

  if (estado === "expired") return <Expirado texto="🎬 Video" saliente={false} />;

  return (
    <figure style={{ margin: 0 }} data-testid="burbuja-video">
      {url ? (
        <video
          src={url}
          controls
          preload="metadata"
          playsInline
          style={{ width: 280, maxWidth: "100%", maxHeight: 360, borderRadius: 12, display: "block", background: "#000" }}
        />
      ) : (
        <button
          onClick={cargar}
          data-testid="video-cargar"
          style={{
            width: 280,
            maxWidth: "100%",
            height: 160,
            borderRadius: 12,
            border: "1px solid var(--hairline)",
            background: "var(--hairline)",
            color: "var(--ink)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {estado === "loading" ? "Cargando video…" : estado === "error" ? "No se pudo cargar" : "▶ Ver video"}
        </button>
      )}
      {media.caption ? <figcaption style={{ fontSize: 13, marginTop: 4 }}>{media.caption}</figcaption> : null}
    </figure>
  );
}

/** DOCUMENTO. Se baja por blob para poder mandarlo con su nombre real al disco. */
export function DocumentBubble({ media, leidoPorElAsistente }: { media: MessageMedia; leidoPorElAsistente?: boolean }) {
  const { estado, url, cargar } = useMediaBlob(media.url, { auto: false });
  const familia = familiaDeMime(media.mime, media.filename);
  const nombre = media.filename ?? "Documento";

  const descargar = () => {
    if (!url) {
      cargar();
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  if (estado === "expired") return <Expirado texto={`📄 ${nombre}`} saliente={false} />;

  return (
    <div data-testid="burbuja-documento" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 220 }}>
      <span style={{ fontSize: 26, lineHeight: 1 }} aria-hidden>{ICONO_DOCUMENTO[familia]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nombre}</div>
        {leidoPorElAsistente ? (
          <div style={{ fontSize: 11, opacity: 0.7 }}>Leído por el asistente</div>
        ) : null}
      </div>
      <button
        onClick={descargar}
        style={{ border: "none", borderRadius: 999, padding: "4px 12px", fontSize: 12, cursor: "pointer", background: "var(--acc)", color: "var(--acc-ink)" }}
      >
        {estado === "loading" ? "…" : url ? "Guardar" : "Descargar"}
      </button>
    </div>
  );
}

/** UBICACIÓN. Sin mapa embebido: una imagen estática de Google cuesta por carga y clave. */
export function LocationBubble({ media }: { media: MessageMedia }) {
  const loc = media.location;
  if (!loc) return null;
  const maps = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  return (
    <div data-testid="burbuja-ubicacion" style={{ minWidth: 200 }}>
      <div style={{ fontSize: 13, display: "flex", gap: 6 }}>
        <span aria-hidden>📍</span>
        <span>
          {loc.name ? <strong style={{ fontWeight: 600 }}>{loc.name}</strong> : "Ubicación compartida"}
          {loc.address ? <span style={{ display: "block", opacity: 0.85 }}>{loc.address}</span> : null}
        </span>
      </div>
      <a
        href={maps}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "inline-block", marginTop: 6, fontSize: 12.5, textDecoration: "underline" }}
      >
        Abrir en Google Maps
      </a>
    </div>
  );
}

/** CONTACTO compartido. El botón lleva a /clientes con el teléfono ya puesto. */
export function ContactsBubble({ media }: { media: MessageMedia }) {
  const lista = media.contacts;
  if (!lista?.length) return null;
  return (
    <div data-testid="burbuja-contactos" style={{ minWidth: 200, display: "flex", flexDirection: "column", gap: 8 }}>
      {lista.map((c, i) => (
        <div key={i} style={{ fontSize: 13 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <span aria-hidden>👤</span>
            <strong style={{ fontWeight: 600 }}>{c.name}</strong>
          </div>
          {c.phones.map((t) => (
            <div key={t} style={{ opacity: 0.85, marginLeft: 20 }}>{t}</div>
          ))}
          {c.phones[0] ? (
            <a
              href={`/clientes?nuevo=1&telefono=${encodeURIComponent(c.phones[0])}`}
              style={{ display: "inline-block", marginTop: 4, marginLeft: 20, fontSize: 12.5, textDecoration: "underline" }}
            >
              Guardar como contacto
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}
