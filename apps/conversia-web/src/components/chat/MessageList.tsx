"use client";

import { Fragment, memo, useCallback, useMemo, useState } from "react";
import type { MessageMedia } from "../../lib/message-media";
import {
  abreDia,
  esSoloEmojis,
  etiquetaAccesible,
  etiquetaDeDia,
  siguenJuntos,
  tickDeEstado,
  traducirPlaceholderViejo,
  trozosConEnlaces,
} from "../../lib/chat-format";
import { AudioBubble } from "./AudioBubble";
import { ContactsBubble, DocumentBubble, ImageBubble, LocationBubble, StickerBubble, VideoBubble } from "./MediaBubbles";
import { MediaViewer, type FotoDelVisor } from "./MediaViewer";

/**
 * EL HILO. Lo que convierte una lista de filas en algo que se lee como un chat.
 *
 * Tres cosas que no se ven pero se notan: los separadores de día (sin ellos, a los dos días
 * no se sabe si un mensaje es de ayer o de la semana pasada), la agrupación de mensajes
 * seguidos del mismo autor (sin ella, cada línea repite hora y ticks y el hilo se llena de
 * ruido) y los ticks de estado, que son la única forma que tiene el dueño de saber si lo que
 * mandó llegó.
 *
 * Las decisiones de cuándo abrir día, cuándo agrupar y qué tick corresponde viven en
 * `lib/chat-format.ts`, puras y con tests. Acá solo se dibujan.
 */

export interface MensajeDelHilo {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  visibility: "PUBLIC" | "INTERNAL";
  body: string | null;
  authorType: "USER" | "AGENT" | "SYSTEM";
  authorName: string | null;
  status: string;
  createdAt: string;
  payload?: unknown;
  media?: MessageMedia | null;
}

export interface AccionesDeSugerencia {
  aprobar: (id: string, texto?: string) => void;
  descartar: (id: string) => void;
}

export function MessageList({
  mensajes,
  acciones,
  soloLectura,
  ahora,
}: {
  mensajes: MensajeDelHilo[];
  acciones?: AccionesDeSugerencia;
  soloLectura?: boolean;
  /** Inyectable para poder probar «Hoy»/«Ayer» sin depender del día en que se corra. */
  ahora?: Date;
}) {
  const [visor, setVisor] = useState<{ i: number } | null>(null);

  /**
   * TODAS las fotos del hilo, en orden. Salen de los mensajes y no de lo que ya se descargó:
   * las miniaturas son `lazy`, así que en una pantalla chica la mayoría no está bajada y el
   * visor se quedaría sin fotos por las que pasar. Los stickers quedan fuera a propósito —
   * pasar de una foto a una calcomanía no tiene sentido.
   */
  const fotosDelHilo = useMemo<FotoDelVisor[]>(
    () =>
      mensajes
        .filter((m) => m.media?.kind === "image" && m.media?.url)
        .map((m) => ({ id: m.id, ruta: m.media!.url, caption: m.media?.caption ?? null })),
    [mensajes],
  );

  const abrirVisor = useCallback(
    (id: string) => {
      const i = fotosDelHilo.findIndex((f) => f.id === id);
      setVisor({ i: Math.max(0, i) });
    },
    [fotosDelHilo],
  );

  const visibles = mensajes.filter((m) => m.visibility !== "INTERNAL" || m.type === "NOTE");

  return (
    <>
      {visibles.map((m, idx) => {
        const anterior = idx > 0 ? visibles[idx - 1] : null;
        const siguiente = idx < visibles.length - 1 ? visibles[idx + 1] : null;
        const nuevoDia = abreDia(m.createdAt, anterior?.createdAt);
        const continua = siguenJuntos(m, anterior);
        // Solo el ÚLTIMO del bloque muestra hora y ticks.
        const cierraBloque = !siguiente || !siguenJuntos(siguiente, m);
        return (
          // Fragmento y NO un <div>: la burbuja tiene que seguir siendo hija DIRECTA del
          // contenedor flex del hilo. Envuelta en un div, su `alignSelf: flex-end` deja de
          // aplicar y los mensajes salientes se van a la izquierda.
          <Fragment key={m.id}>
            {nuevoDia ? (
              <div
                data-testid="separador-dia"
                style={{ textAlign: "center", margin: "14px 0 10px", fontSize: 11, color: "var(--ink-dim)", alignSelf: "stretch" }}
              >
                <span style={{ background: "var(--surface-solid)", border: "1px solid var(--hairline)", borderRadius: 999, padding: "2px 10px" }}>
                  {etiquetaDeDia(m.createdAt, ahora)}
                </span>
              </div>
            ) : null}
            <Burbuja
              m={m}
              continua={continua}
              cierraBloque={cierraBloque}
              acciones={soloLectura ? undefined : acciones}
              onAbrirFoto={abrirVisor}
            />
          </Fragment>
        );
      })}
      {visor ? <MediaViewer fotos={fotosDelHilo} indiceInicial={visor.i} onCerrar={() => setVisor(null)} /> : null}
    </>
  );
}

/**
 * Memoizada por lo único que puede cambiar de un mensaje ya dibujado: su estado y sus
 * reacciones. Sin esto, cada evento SSE vuelve a renderizar las 300 burbujas del hilo.
 */
const Burbuja = memo(
  function Burbuja({
    m,
    continua,
    cierraBloque,
    acciones,
    onAbrirFoto,
  }: {
    m: MensajeDelHilo;
    continua: boolean;
    cierraBloque: boolean;
    acciones?: AccionesDeSugerencia;
    onAbrirFoto: (id: string) => void;
  }) {
    const out = m.direction === "OUTBOUND";
    const nota = m.visibility === "INTERNAL";
    const sugerida = m.status === "SUGGESTED";
    const media = m.media ?? null;
    const kind = media?.kind ?? null;
    const tick = cierraBloque ? tickDeEstado(m.status, m.direction) : null;

    // Un sticker y un emoji suelto no llevan fondo de burbuja: son la ilustración misma.
    const sinFondo = kind === "sticker" || (!kind && esSoloEmojis(m.body));

    const esquinas = continua
      ? out
        ? "16px 6px 16px 16px"
        : "6px 16px 16px 16px"
      : "16px";

    return (
      <div style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "80%", marginTop: continua ? 2 : 8, display: "flex", flexDirection: "column", alignItems: out ? "flex-end" : "flex-start" }}>
        <div
          aria-label={kind ? etiquetaAccesible(kind, media?.durationSec) : undefined}
          data-testid={`mensaje-${kind ?? "texto"}`}
          style={{
            position: "relative",
            padding: sinFondo ? 0 : "9px 13px",
            borderRadius: esquinas,
            fontSize: sinFondo && !kind ? 34 : 14,
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: sinFondo
              ? "transparent"
              : sugerida
                ? "color-mix(in srgb, var(--acc) 12%, var(--surface-solid))"
                : nota
                  ? "color-mix(in srgb, var(--warn) 16%, var(--surface-solid))"
                  : out
                    ? "var(--acc)"
                    : "var(--surface-solid)",
            color: sugerida || nota ? "var(--ink)" : out && !sinFondo ? "var(--acc-ink)" : "var(--ink)",
            border: sinFondo ? "none" : sugerida ? "1px dashed var(--acc)" : out || nota ? "none" : "1px solid var(--hairline)",
          }}
        >
          <Contenido m={m} media={media} out={out} onAbrirFoto={onAbrirFoto} />

          {media?.reactions?.length ? (
            <span
              data-testid="reaccion"
              style={{
                position: "absolute",
                bottom: -9,
                [out ? "left" : "right"]: 8,
                background: "var(--surface-solid)",
                border: "1px solid var(--hairline)",
                borderRadius: 999,
                padding: "0 5px",
                fontSize: 11,
                lineHeight: "17px",
              } as React.CSSProperties}
            >
              {media.reactions.map((r) => r.emoji).join("")}
            </span>
          ) : null}
        </div>

        {sugerida && acciones ? (
          <div style={{ display: "flex", gap: 6, marginTop: 4, justifyContent: "flex-end" }}>
            <button onClick={() => acciones.aprobar(m.id)} className="btn-accent" style={{ fontSize: 12, padding: "4px 12px" }}>Aprobar y enviar</button>
            <button
              onClick={() => {
                const t = prompt("Editar la respuesta antes de enviar:", m.body ?? "");
                if (t && t.trim()) acciones.aprobar(m.id, t.trim());
              }}
              style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}
            >
              Editar
            </button>
            <button onClick={() => acciones.descartar(m.id)} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)", background: "transparent", color: "var(--ink-dim)", cursor: "pointer" }}>Descartar</button>
          </div>
        ) : null}

        {cierraBloque ? (
          <div className="text-dim" style={{ fontSize: 10, marginTop: media?.reactions?.length ? 12 : 2, textAlign: out ? "right" : "left" }}>
            {sugerida ? "Sugerencia del asistente · " : m.authorType === "AGENT" ? "IA · " : ""}
            {nota ? "Nota · " : ""}
            {new Date(m.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
            {tick ? (
              <span title={tick.etiqueta} aria-label={tick.etiqueta} style={{ marginLeft: 4, color: tick.destacado ? "var(--acc)" : undefined }}>
                {tick.simbolo}
              </span>
            ) : null}
            {out && m.status === "FAILED" ? " · no se envió" : ""}
          </div>
        ) : null}
      </div>
    );
  },
  (a, b) =>
    a.m.id === b.m.id &&
    a.m.status === b.m.status &&
    a.continua === b.continua &&
    a.cierraBloque === b.cierraBloque &&
    JSON.stringify(a.m.media?.reactions ?? null) === JSON.stringify(b.m.media?.reactions ?? null),
);

function Contenido({
  m,
  media,
  out,
  onAbrirFoto,
}: {
  m: MensajeDelHilo;
  media: MessageMedia | null;
  out: boolean;
  onAbrirFoto: (id: string) => void;
}) {
  switch (media?.kind) {
    case "audio":
      return <AudioBubble media={media} saliente={out} />;
    case "image":
      return <ImageBubble media={media} onAbrir={() => onAbrirFoto(m.id)} />;
    case "sticker":
      return <StickerBubble media={media} />;
    case "video":
      return <VideoBubble media={media} />;
    case "document":
      return <DocumentBubble media={media} leidoPorElAsistente={!!(m.payload as { documentText?: string } | null)?.documentText} />;
    case "location":
      return <LocationBubble media={media} />;
    case "contacts":
      return <ContactsBubble media={media} />;
    default: {
      // Texto. Los `[tipo]` que quedaron de antes de D1 se traducen acá: el script de
      // reparación no toca todo y siempre puede quedar una fila vieja.
      const texto = traducirPlaceholderViejo(m.body);
      if (!texto) return null;
      return (
        <>
          {trozosConEnlaces(texto).map((t, i) =>
            t.tipo === "enlace" ? (
              <a key={i} href={t.valor} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline", color: "inherit" }}>
                {t.valor}
              </a>
            ) : (
              <span key={i}>{t.valor}</span>
            ),
          )}
        </>
      );
    }
  }
}
