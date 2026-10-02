import { getToken } from "@/lib/api";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type RealtimeEvent = {
  type: "connected" | "message.created" | "message.updated" | "conversation.updated" | "counters.dirty";
  conversationId?: string;
  data?: unknown;
  at?: string;
};

/**
 * Suscripción en TIEMPO REAL a la bandeja (SSE). Usa fetch + ReadableStream en vez de
 * EventSource porque necesitamos mandar el token en la cabecera Authorization (EventSource
 * no permite cabeceras). Reconecta solo con backoff. Devuelve una función para cerrar.
 */
export function openRealtime(onEvent: (e: RealtimeEvent) => void): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let retry = 0;

  async function connect() {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(`${API}/conversations/stream/updates`, {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      retry = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Los eventos SSE se separan por línea en blanco; cada línea de datos empieza con "data:".
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()) as RealtimeEvent);
          } catch {
            /* ignora líneas que no sean JSON (keepalive) */
          }
        }
      }
    } catch {
      /* caída de red / abort → reintenta salvo cierre explícito */
    }
    if (!closed) {
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 1000 * retry);
    }
  }

  connect();
  return () => {
    closed = true;
    controller?.abort();
  };
}
