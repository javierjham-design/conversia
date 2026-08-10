import type { ChannelResult, NotificationChannel } from "@conversia/notifications";

/**
 * STUB del canal PUSH NATIVO (APNs/FCM). NO implementado a propósito: hoy
 * publicamos PWA (Web Push). El día de Capacitor, este es el ÚNICO archivo a
 * escribir + registrarlo en el despachador (registerChannel(nativePushChannel)):
 * nada más cambia, porque los dispositivos ya se guardan en push_devices con
 * platform=ios|android y kind=apns|fcm.
 *
 * TODO(capacitor):
 *  1. Leer los push_devices del usuario con kind IN ('apns','fcm').
 *  2. APNs: JWT con la clave .p8 (APNS_KEY_ID, APNS_TEAM_ID, bundle id) →
 *     POST https://api.push.apple.com/3/device/{token}.
 *  3. FCM: HTTP v1 con service account → POST a /messages:send.
 *  4. Mapear respuestas 410/Unregistered → expiredIdentifiers (limpieza).
 *  5. Añadir env: APNS_* y FCM_SERVICE_ACCOUNT; ver docs/MOBILE.md.
 */
export const nativePushChannel: NotificationChannel = {
  channel: "native_push",
  async send(): Promise<ChannelResult> {
    // Hasta implementarlo, se registra como "skipped" (no rompe el despacho).
    return { status: "skipped", error: "push nativo no implementado (PWA/Web Push activo)" };
  },
};
