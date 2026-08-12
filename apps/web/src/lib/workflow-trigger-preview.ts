// Vista previa en lenguaje natural del disparador de un flujo + prueba local de
// coincidencia de mensaje. Puro (sin React ni red) para poder testearlo. El
// texto refleja fielmente la lógica del motor (`matchesTrigger`/`matchesKeywords`
// en @conversia/workflows): si esto miente, el flujo hará algo distinto a lo que
// dice la etiqueta. Cubierto por workflow-trigger-preview.test.ts.

type Cfg = Record<string, unknown>;

/** Búsquedas opcionales para poner nombres legibles (etapas, canales). */
export interface PreviewLookups {
  leadStatusName?: (code: string) => string | undefined;
  channelName?: (id: string) => string | undefined;
}

function words(cfg: Cfg): string[] {
  return [
    ...(Array.isArray(cfg.keywords) ? cfg.keywords.map(String) : []),
    ...(typeof cfg.keyword === "string" ? [cfg.keyword] : []),
  ]
    .map((w) => w.trim())
    .filter(Boolean);
}

function quoteList(items: string[]): string {
  const q = items.map((w) => `«${w}»`);
  if (q.length <= 1) return q[0] ?? "";
  return `${q.slice(0, -1).join(", ")} o ${q[q.length - 1]}`;
}

/**
 * Frase «Se activará cuando…» a partir del tipo y la config del disparador.
 * Devuelve la oración completa (sin el prefijo), lista para mostrar.
 */
export function triggerPreview(type: string, config: Cfg = {}, look: PreviewLookups = {}): string {
  const cfg = config ?? {};
  switch (type) {
    case "conversation_started":
      return "un contacto inicia una conversación (su primer mensaje).";
    case "conversation_closed":
      return "se cierra una conversación.";
    case "message_received":
    case "keyword": {
      const ws = words(cfg);
      const ch = typeof cfg.channel === "string" && cfg.channel ? (look.channelName?.(cfg.channel) ?? cfg.channel) : "";
      const first = cfg.firstMessage === true ? " (solo si es su primer mensaje)" : "";
      let base: string;
      if (ws.length === 0) {
        base = "un contacto envía cualquier mensaje";
      } else {
        const mode = cfg.matchType === "exact" ? "es exactamente" : "contiene";
        const join = cfg.matchAll === true && ws.length >= 2 && cfg.matchType !== "exact" ? " y todas" : "";
        base = `un contacto envía un mensaje que ${mode}${join ? " " : " "}${quoteList(ws)}`;
      }
      const via = ch ? ` por ${ch}` : "";
      return `${base}${via}${first}.`;
    }
    case "click_to_chat": {
      if (cfg.mode === "selected") {
        const ads = (Array.isArray(cfg.adIds) ? cfg.adIds.length : 0) + (typeof cfg.adId === "string" && cfg.adId.trim() ? 1 : 0);
        const camps = Array.isArray(cfg.campaignIds) ? cfg.campaignIds.length : 0;
        const parts = [ads ? `${ads} anuncio${ads === 1 ? "" : "s"}` : "", camps ? `${camps} campaña${camps === 1 ? "" : "s"}` : ""].filter(Boolean);
        return `alguien escribe desde ${parts.length ? parts.join(" o ") : "los anuncios seleccionados"} de Click-to-WhatsApp.`;
      }
      return "alguien escribe desde cualquier anuncio Click-to-WhatsApp.";
    }
    case "lead_status_changed": {
      const from = typeof cfg.fromStatus === "string" && cfg.fromStatus ? (look.leadStatusName?.(cfg.fromStatus) ?? cfg.fromStatus) : "";
      const to = typeof cfg.toStatus === "string" && cfg.toStatus ? (look.leadStatusName?.(cfg.toStatus) ?? cfg.toStatus) : "";
      if (!from && !to) return "un contacto cambia de etapa en el embudo.";
      if (from && to) return `un contacto pasa de «${from}» a «${to}».`;
      if (to) return `un contacto pasa a la etapa «${to}».`;
      return `un contacto sale de la etapa «${from}».`;
    }
    case "tag_added": {
      const tag = typeof cfg.tag === "string" ? cfg.tag.trim() : "";
      return tag ? `se le agrega la etiqueta «${tag}» a un contacto.` : "se le agrega cualquier etiqueta a un contacto.";
    }
    case "appointment_upcoming": {
      const h = Number(cfg.hoursBefore ?? 24);
      const off = cfg.avoidOffHours !== false ? " (respetando el horario de atención)" : "";
      return `faltan ${h} hora${h === 1 ? "" : "s"} para una cita${off}.`;
    }
    case "appointment_created":
      return "se agenda una cita nueva.";
    case "appointment_confirmed":
      return "se confirma una cita.";
    case "appointment_rescheduled":
      return "se reagenda una cita.";
    case "appointment_cancelled":
      return "se cancela una cita.";
    case "no_show":
      return "un paciente no asiste a su cita (no-show).";
    case "link_scan": {
      const code = typeof cfg.code === "string" ? cfg.code.trim() : "";
      return code
        ? `alguien abre tu enlace/QR (código «${code}») y envía el mensaje predefinido por WhatsApp.`
        : "alguien abre tu enlace/QR y envía el mensaje predefinido (falta generar el código).";
    }
    case "manual":
      return "lo lanzas manualmente (o desde otro flujo / acción masiva).";
    default:
      return "ocurre el evento configurado.";
  }
}

/** Refleja `matchesKeywords` del motor: ¿este texto dispararía las condiciones? */
export function messageWouldTrigger(cfg: Cfg, text: string): boolean {
  const ws = words(cfg).map((w) => w.toLowerCase());
  if (ws.length === 0) return true;
  const haystack = text.toLowerCase().trim();
  const exact = cfg.matchType === "exact";
  const test = (w: string) => (exact ? haystack === w : haystack.includes(w));
  return cfg.matchAll === true ? ws.every(test) : ws.some(test);
}
