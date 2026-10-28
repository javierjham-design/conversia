/** Canales de entrega. `native_push` queda declarado para el día de Capacitor. */
export type NotifChannel = "in_app" | "web_push" | "email" | "native_push" | "whatsapp";

export type NotifUrgency = "critical" | "info";

/** A quién va un evento (se resuelve a usuarios concretos en el despachador). */
export type NotifAudience = "assigned_user" | "team" | "tenant_admins" | "owner";

/**
 * Definición de un evento en el CATÁLOGO. Agregar un evento = añadir una entrada
 * aquí; ni el despachador ni los canales cambian.
 */
export interface NotifEventDef {
  key: string;
  /** Plantillas con variables {var} rellenadas con los datos del evento. */
  title: string;
  body: string;
  audience: NotifAudience[];
  urgency: NotifUrgency;
  /** Canales PERMITIDOS para este evento. */
  channels: NotifChannel[];
  /** Canales ENCENDIDOS por defecto (subconjunto de channels). */
  defaultChannels: NotifChannel[];
  /** Canales que el usuario NO puede apagar (p. ej. facturación al dueño). */
  lockedChannels?: NotifChannel[];
  /** Deep-link al tocar la notificación (con variables {var}). */
  link?: string;
  /** Uso interno (p. ej. prueba): no se muestra en la matriz de preferencias. */
  hidden?: boolean;
}

/** Contexto para resolver la audiencia del evento a usuarios concretos. */
export interface NotifRecipientContext {
  /** Usuario asignado a la conversación (para audiencia `assigned_user`). */
  assignedUserId?: string | null;
  /** Equipo asignado (para audiencia `team`). */
  teamId?: string | null;
  conversationId?: string | null;
  /** Quién causó el evento: NO se le notifica a sí mismo. */
  actorUserId?: string | null;
}

/** Payload que viaja por la cola. La audiencia se resuelve en el despachador. */
export interface NotifJob {
  eventKey: string;
  organizationId: string;
  /** Contexto para resolver la audiencia (assigned_user / team / admins / owner). */
  context?: NotifRecipientContext;
  /** Override: destinatarios ya resueltos (si viene, se ignora la audiencia). */
  userIds?: string[];
  /** Datos para rellenar plantillas y deep-link. */
  data: Record<string, string | number | null | undefined>;
  /** Conversación asociada (para dedup, agrupación y cancelación de la escalera). */
  conversationId?: string;
}

/** Resultado de un canal al intentar entregar. */
export interface ChannelResult {
  status: "sent" | "failed" | "skipped";
  error?: string;
  /** Endpoints/tokens que el proveedor reportó como caducados (para limpiar). */
  expiredIdentifiers?: string[];
}

/** Contrato común de todos los canales. El despachador no conoce sus detalles. */
export interface NotificationChannel {
  readonly channel: NotifChannel;
  send(input: {
    userId: string;
    organizationId: string;
    event: NotifEventDef;
    title: string;
    body: string;
    link?: string;
    /**
     * CRE 3 — marca del destinatario. El correo y el enlace tienen que salir con SU dominio
     * y SU nombre: antes el canal de correo armaba la URL con `WEB_URL` (la de TuBot) y
     * firmaba "Abrir en TuBot", así que a un cliente de Conversia le llegaba un aviso de su
     * propio saldo que lo mandaba a la aplicación de otra marca.
     */
    brand?: { key: string; name: string; webUrl: string };
    data: Record<string, unknown>;
  }): Promise<ChannelResult>;
}
