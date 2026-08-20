// Parser PURO (testeable sin BD) de los webhooks de mensajería de Meta:
// Messenger (object=page, entry[].messaging[]) e Instagram Direct
// (object=instagram, entry[].messaging[]). Ambos llegan por la app TuBot CRM
// al MISMO webhook que leadgen (/webhooks/meta-crm) y se rutean al tenant por
// el asset de página/IG registrado al conectar la página.

export type MessagingPlatform = "messenger" | "instagram";

export interface MessagingEvent {
  platform: MessagingPlatform;
  /** id de la página (Messenger) o de la cuenta IG business (Instagram) */
  channelExternalId: string;
  /** PSID (Messenger) o IGSID (Instagram) del remitente */
  senderId: string;
  /** mid del mensaje (dedupe por external_id) */
  externalId: string;
  text: string | null;
  /** adjuntos (image/video/audio/file/share) — v1 los registra como [tipo] */
  attachmentType: string | null;
  timestamp: number;
  /** true si lo envió la propia página (eco de un envío nuestro) → ignorar */
  isEcho: boolean;
}

/** Extrae los eventos de mensajería de un payload de webhook de Meta. */
export function parseMessagingEvents(raw: any): MessagingEvent[] {
  const events: MessagingEvent[] = [];
  const object = String(raw?.object ?? "");
  const platform: MessagingPlatform | null =
    object === "page" ? "messenger" : object === "instagram" ? "instagram" : null;
  if (!platform) return events;

  for (const entry of raw?.entry ?? []) {
    // Forma A: entry.messaging[] (Messenger clásico y muestras de página).
    // Forma B: entry.changes[] con field="messages" (topic instagram y tests
    // del dashboard envuelven el mismo value ahí) — mismo contenido adentro.
    const items: any[] = [
      ...(entry?.messaging ?? []),
      ...((entry?.changes ?? [])
        .filter((c: any) => c?.field === "messages" && c?.value)
        .map((c: any) => c.value)),
    ];
    for (const m of items) {
      const msg = m?.message;
      if (!msg?.mid) continue; // postbacks/read/delivery: fuera del v1
      events.push({
        platform,
        channelExternalId: String(entry.id ?? m?.recipient?.id ?? ""),
        senderId: String(m?.sender?.id ?? ""),
        externalId: String(msg.mid),
        text: typeof msg.text === "string" && msg.text.length ? msg.text : null,
        attachmentType: msg.attachments?.[0]?.type ? String(msg.attachments[0].type) : null,
        timestamp: Number(m?.timestamp ?? Date.now()),
        isEcho: msg.is_echo === true,
      });
    }
  }
  return events.filter((e) => e.channelExternalId && e.senderId && !e.isEcho);
}
