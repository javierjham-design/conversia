/**
 * §4.6 — Estados de mensaje MONÓTONOS.
 *
 * Meta manda los status por webhook y NO garantiza el orden: `delivered` puede llegar
 * después de `read`, y un `sent` rezagado puede llegar cuando el mensaje ya se leyó. Con
 * un `update` a secas, cada webhook pisaba el estado anterior, así que en la Bandeja un
 * mensaje ya leído volvía a "enviado" y un FAILED se borraba con un `delivered` tardío —
 * y FAILED es el que lleva el motivo del rebote.
 *
 * Reglas:
 *  - El progreso normal solo avanza: PENDING → SENT → DELIVERED → READ.
 *  - FAILED es TERMINAL: ningún status posterior lo pisa.
 *  - READ no se baja: un mensaje leído estuvo entregado, pase lo que pase después.
 *  - SUGGESTED (borrador del copiloto) no es parte de este flujo y no se toca.
 */

export type EstadoMensaje = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "SUGGESTED";

/** Progreso de entrega. FAILED y SUGGESTED quedan fuera a propósito (no son "avance"). */
const PROGRESO: EstadoMensaje[] = ["PENDING", "SENT", "DELIVERED", "READ"];

/**
 * Estados DESDE los que se permite pasar a `destino`. Se usa como filtro en el
 * `updateMany`: si el estado actual no está en la lista, la fila no se toca (0 filas
 * actualizadas, sin carrera posible — lo decide la base, no un read-modify-write).
 */
export function estadosQuePermiten(destino: EstadoMensaje): EstadoMensaje[] {
  if (destino === "FAILED") {
    // Un rebote informa de algo que no llegó; si ya constaba LEÍDO, llegó. No se baja.
    return ["PENDING", "SENT", "DELIVERED"];
  }
  const i = PROGRESO.indexOf(destino);
  if (i < 0) return []; // destino desconocido (o SUGGESTED): no se mueve nada
  return PROGRESO.slice(0, i); // solo los anteriores: nunca hacia atrás, nunca sobre FAILED
}

/** ¿Se permite el salto `actual` → `destino`? (la misma regla, para tests y lectores). */
export function permiteTransicion(actual: EstadoMensaje, destino: EstadoMensaje): boolean {
  return estadosQuePermiten(destino).includes(actual);
}

/** Traduce el `status` del webhook de Meta al estado interno. */
export function estadoDesdeMeta(status: string): EstadoMensaje {
  switch (status) {
    case "read":
      return "READ";
    case "delivered":
      return "DELIVERED";
    case "failed":
      return "FAILED";
    default:
      return "SENT";
  }
}
