import { claveDeMedio, type Storage } from "./index.js";

/**
 * GUARDAR UN MEDIO DE UN MENSAJE — una sola implementación para la API y el worker.
 *
 * La API guarda al PRIMER USO (cuando alguien abre el archivo) y el worker guarda AL INGRESO
 * los audios que transcribe y las imágenes que mira el agente, porque esos bytes ya están en
 * memoria. Son dos momentos distintos, pero el "qué se escribe" es idéntico: un objeto en el
 * bucket, una fila en `files` y el `message_attachments` que las une.
 *
 * El `tx` va DUCK-TYPED a propósito: `@conversia/storage` no depende de Prisma ni de
 * `@conversia/database`. Así el paquete sigue siendo probable sin base de datos y los dos
 * llamadores pasan su propio cliente dentro de `withTenant`.
 */

export interface TxDeMedios {
  messageAttachment: {
    findFirst(args: { where: { messageId: string; kind: string } }): Promise<{ fileId: string | null } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  file: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

export type KindDeMedio = "image" | "sticker" | "audio" | "video" | "document";

/**
 * Nunca lanza. Si el bucket falla, quien llamó ya tiene los bytes y su trabajo hecho: perder
 * la copia es mucho menos grave que convertir un turno bueno —o una vista que funcionaba— en
 * un error.
 */
export async function guardarMedioDeMensaje(
  s: Storage | null,
  tx: TxDeMedios,
  input: {
    organizationId: string;
    messageId: string;
    kind: KindDeMedio;
    body: Buffer;
    mime: string;
    nombre?: string | null;
  },
): Promise<void> {
  if (!s) return;
  try {
    const existe = await tx.messageAttachment.findFirst({ where: { messageId: input.messageId, kind: input.kind } });
    if (existe?.fileId) return; // ya guardado
    const key = claveDeMedio(input.organizationId, input.messageId, input.kind, input.mime);
    await s.put(key, input.body, input.mime);
    const file = await tx.file.create({
      data: {
        organizationId: input.organizationId,
        bucket: s.bucket,
        key,
        name: input.nombre ?? `${input.kind}.${key.split(".").pop() ?? "bin"}`,
        mime: input.mime,
        size: input.body.byteLength,
        scope: "message",
      },
    });
    await tx.messageAttachment.create({
      data: { organizationId: input.organizationId, messageId: input.messageId, kind: input.kind, fileId: file.id, mime: input.mime },
    });
  } catch (e) {
    console.error(`✖ No se pudo guardar el medio del mensaje ${input.messageId} (${(e as Error).message?.slice(0, 120)})`);
  }
}
