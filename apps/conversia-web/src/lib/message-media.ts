/**
 * ESPEJO LOCAL de `MessageMedia` (el contrato canónico vive en `@conversia/types`).
 *
 * Por qué no se importa: **conversia-web no depende de ningún paquete del monorepo**. Es una
 * app Next independiente con su propio Dockerfile, igual que el panel de TuBot. Agregarle una
 * dependencia de workspace le cambiaría la forma de compilación a una app que está en
 * producción, y eso es un riesgo que no vale la pena correr por un tipo.
 *
 * Para que no se desincronice hay un guardián en la suite de la API
 * (`apps/api/test/message-media-espejo.spec.ts`) que compara los campos de este archivo con
 * los del esquema zod. Si alguien agrega un campo allá y no acá, ese test se cae.
 */

export type MessageMediaKind = "audio" | "image" | "sticker" | "video" | "document" | "location" | "contacts";

export interface MessageMedia {
  kind: MessageMediaKind | null;
  url: string | null;
  mime: string | null;
  filename: string | null;
  caption: string | null;
  animated: boolean | null;
  durationSec: number | null;
  transcript: string | null;
  location: { lat: number; lng: number; name: string | null; address: string | null } | null;
  contacts: Array<{ name: string; phones: string[] }> | null;
  reactions: Array<{ emoji: string; at: string | null }> | null;
}

/** Código que manda la API cuando Meta ya borró el archivo. */
export const MEDIA_EXPIRED = "MEDIA_EXPIRED";
