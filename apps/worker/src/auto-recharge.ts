import { PREFIJO_ORDEN_RECARGA } from "@conversia/agents";
import type { SubscriptionProvider } from "./subscription-billing/provider";

/**
 * CRE 2 — RECARGA AUTOMÁTICA DE CRÉDITOS IA (`docs/MODELO_COBRO_CREDITOS_IA.md` §6).
 *
 * Cuando el saldo del cliente baja del umbral, se cobra solo un pack a la tarjeta que
 * guardó con Flow. Se dispara ANTES de llegar a 0 para que el bot no se corte mientras el
 * pago se procesa.
 *
 * Hasta ahora esto estaba a medio construir: existía la pantalla de configuración
 * (`GET/PUT /billing/auto-recharge`, desde V2-2) pero **nada la disparaba**. El cliente
 * podía activarla, poner su tope y quedarse sin saldo igual.
 *
 * COBRA PLATA DE VERDAD, así que todo lo que puede salir mal tiene su freno:
 *  - **Consentimiento explícito y registrado**: sin él no se cobra, aunque el flag esté on.
 *  - **Tope mensual obligatorio**: al alcanzarlo se avisa y no se cobra más.
 *  - **Un cobro a la vez**: mientras haya un intento en vuelo no se dispara otro. Sin esto,
 *    el saldo sigue bajo hasta que el webhook confirme y se cobrarían N packs seguidos.
 *  - **Marca propia en el `commerceOrder`** (`rec-`): el motor de suscripciones NO debe ver
 *    estos intentos. Si los viera, (1) dejaría de cobrar la mensualidad mientras hay una
 *    recarga en vuelo y (2) al confirmarse la recarga la reconciliación renovaría el
 *    período de la suscripción **gratis**.
 *
 * La decisión es una función PURA (`decidirRecarga`) para poder probar cada freno sin
 * pasarela ni base de datos.
 */

/**
 * Prefijo que distingue un cobro de RECARGA de uno de suscripción. El valor vive en
 * `@conversia/agents` porque el api también lo necesita (para cerrar el intento cuando la
 * pasarela confirma el pago); se re-exporta acá para no tocar a quien ya lo importa.
 */
export const RECHARGE_ORDER_PREFIX = PREFIJO_ORDEN_RECARGA;

/**
 * Horas de espera tras un cobro RECHAZADO antes de volver a intentar.
 *
 * Sin esto el tick (cada 15 min) reintentaba la MISMA tarjeta rechazada indefinidamente:
 * el intento fallido no cuenta contra el tope mensual —que mide cobros exitosos y en
 * vuelo— ni queda "en vuelo", así que el saldo seguía bajo el umbral y la decisión volvía
 * a ser "cobrar". Son 96 cobros rechazados y 96 avisos "tu tarjeta falló" por día, a un
 * cliente que ya se enteró con el primero. Los emisores penalizan el reintento en ráfaga,
 * y un rechazo por fondos insuficientes no se arregla en 15 minutos: se arregla mañana.
 */
export const HORAS_ESPERA_TRAS_FALLO = 24;

/** Rechazos SEGUIDOS tras los cuales se deja de intentar: hace falta otra tarjeta. */
export const MAX_FALLOS_SEGUIDOS = 3;

/**
 * Cuánto tiempo se considera que una recarga puede seguir "en vuelo".
 *
 * Es el plazo que se le da al webhook de la pasarela para cerrar el intento. Pasado eso se
 * asume que no va a llegar y la cuenta puede volver a intentarlo: sin este plazo, un webhook
 * perdido dejaba la recarga automática apagada para siempre y en silencio.
 *
 * Vive en el módulo PURO porque son dos quienes dependen del mismo número: la guarda de "un
 * cobro a la vez" (que lo usa para soltar la cuenta) y la reconciliación de recargas (que lo
 * usa para decidir cuándo un cobro sin respuesta pasa a ser cosa de una persona). Si no
 * fueran el mismo valor, habría una franja en la que la cuenta ya puede volver a cobrar y
 * nadie revisó el cobro anterior — o al revés, una cuenta frenada sin que nadie lo mire.
 */
export const VENTANA_EN_VUELO_MS = 6 * 60 * 60 * 1000;

/** Rechazos consecutivos de recarga (desde el último cobro que no falló). */
export interface FallosDeRecarga {
  seguidos: number;
  ultimoAt: Date | null;
}

/** ¿Este cobro es una recarga automática? (lo usa el motor de suscripciones para ignorarla) */
export function esRecarga(commerceOrder: string): boolean {
  return commerceOrder.startsWith(RECHARGE_ORDER_PREFIX);
}

export interface AutoRechargeConfig {
  enabled: boolean;
  /** Saldo por debajo del cual se dispara (§6: 50 créditos ≈ 12 conversaciones). */
  thresholdRemaining: number;
  packCode: string | null;
  /** Tope de gasto mensual en CLP. Obligatorio: sin tope no se activa. */
  monthlyCapClp: number;
  /** Cuándo aceptó el cliente que le cobremos solos. Sin esto NO se cobra. */
  consentAt: string | null;
}

export type RechargeDecision =
  | "cobrar"
  | "apagada"
  | "sin_consentimiento"
  | "sin_pack"
  | "sin_tarjeta"
  | "saldo_suficiente"
  | "tope_mensual"
  | "en_vuelo"
  | "espera_tras_fallo"
  | "tarjeta_agotada"
  /** El cliente acaba de recargar a mano: no se le cobra otra vez por lo mismo. */
  | "compra_reciente"
  /** La org no cobra en CLP y el cobro recurrente es en CLP: no se cobra automáticamente. */
  | "moneda_no_soportada";

/**
 * ¿Hay que cobrar? Pura. El orden de las guardas importa: primero las que son "no, y punto"
 * (apagada, sin consentimiento, sin tarjeta) y al final las de estado (saldo, tope, vuelo),
 * para que el motivo que se registra sea el más informativo.
 */
export function decidirRecarga(input: {
  cfg: AutoRechargeConfig;
  /** Saldo actual de créditos (lotes vigentes menos gracia usada). */
  saldo: number;
  /** Precio del pack configurado, en CLP. */
  precioClp: number;
  /** Lo ya gastado en recargas automáticas este mes, en CLP. */
  gastadoEsteMesClp: number;
  tieneTarjeta: boolean;
  /** ¿Hay un cobro de recarga pendiente de confirmación? */
  enVuelo: boolean;
  /** ¿El cliente compró una recarga a mano hace muy poco? */
  compraReciente?: boolean;
  /** Rechazos seguidos. Ausente = ninguno (el caso de todos los días). */
  fallos?: FallosDeRecarga;
  /** Momento de la pasada, para medir la espera tras un rechazo. */
  now?: Date;
  /** Moneda de la organización. El precio del pack que se cobra está en CLP. */
  moneda?: string;
}): RechargeDecision {
  const { cfg } = input;
  if (!cfg.enabled) return "apagada";
  if (!cfg.consentAt) return "sin_consentimiento";
  // El cobro va con `priceClp` y la moneda de la org, y la pasarela de cobro recurrente es
  // Flow, que es CLP. Una org en USD habría recibido un cargo de 24.990 DÓLARES (~23
  // millones de pesos). Mejor no cobrar automáticamente que cobrar en la moneda equivocada:
  // esa cuenta recarga a mano hasta que haya un cobro recurrente en USD.
  if ((input.moneda ?? "CLP") !== "CLP") return "moneda_no_soportada";
  if (!cfg.packCode || input.precioClp <= 0) return "sin_pack";
  if (!input.tieneTarjeta) return "sin_tarjeta";
  if (input.enVuelo) return "en_vuelo";
  if (input.compraReciente) return "compra_reciente";
  if (input.saldo >= cfg.thresholdRemaining) return "saldo_suficiente";
  // Rechazos: primero el que es definitivo (la tarjeta no va a funcionar sola) y después
  // la espera. Van DESPUÉS del saldo para que una cuenta que ya recargó a mano —y por lo
  // tanto no necesita nada— no se reporte como bloqueada por un rechazo viejo.
  const fallos = input.fallos;
  if (fallos && fallos.seguidos >= MAX_FALLOS_SEGUIDOS) return "tarjeta_agotada";
  if (fallos?.ultimoAt) {
    const esperaMs = HORAS_ESPERA_TRAS_FALLO * 3_600_000;
    const desde = (input.now ?? new Date()).getTime() - fallos.ultimoAt.getTime();
    if (desde < esperaMs) return "espera_tras_fallo";
  }
  // El tope se mide con ESTE cobro incluido: si pasarlo lo supera, no se cobra. Un tope de
  // $56.970 (3 recargas) tiene que permitir exactamente 3, no 3 y un poquito más.
  if (input.gastadoEsteMesClp + input.precioClp > cfg.monthlyCapClp) return "tope_mensual";
  return "cobrar";
}

/** Config leída de `organization.settings.autoRecharge`, con los defaults del §6. */
export function parseAutoRechargeConfig(raw: unknown, defaults: { threshold: number; monthlyCapClp: number }): AutoRechargeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return {
    enabled: o.enabled === true,
    thresholdRemaining: n(o.thresholdRemaining, defaults.threshold),
    packCode: typeof o.packCode === "string" && o.packCode.trim() ? o.packCode.trim() : null,
    monthlyCapClp: n(o.monthlyCapClp, defaults.monthlyCapClp),
    consentAt: typeof o.consentAt === "string" && o.consentAt.trim() ? o.consentAt : null,
  };
}

export interface RechargeCandidate {
  organizationId: string;
  cfg: AutoRechargeConfig;
  /** Referencia del cliente en la pasarela (null = no tiene tarjeta guardada). */
  customerRef: string | null;
  /** Suscripción vigente, para colgar el intento de cobro (la tabla la exige). */
  subscriptionId: string | null;
  currency: string;
  brandSubject: string;
}

export interface AutoRechargePort {
  /** Orgs que cobran Créditos IA y tienen la recarga automática encendida. */
  listCandidates(): Promise<RechargeCandidate[]>;
  /** Saldo de créditos: lotes vigentes menos gracia usada. */
  balanceOf(organizationId: string): Promise<number>;
  packOf(code: string): Promise<{ code: string; credits: number; priceClp: number } | null>;
  /** CLP ya gastados en recargas automáticas EXITOSAS este mes. */
  spentThisMonth(organizationId: string, now: Date): Promise<number>;
  /** ¿Hay un cobro de recarga pendiente de confirmación? */
  hasPendingRecharge(organizationId: string): Promise<boolean>;
  /**
   * ¿El cliente acaba de recargar A MANO? El aviso de saldo bajo lo manda a comprar al
   * panel, y el tick corre cada 15 minutos: sin esta pregunta, el cliente compraba su
   * recarga y un rato después le llegaba OTRO cobro automático por lo mismo. Dos cobros y
   * el doble de créditos de los que quiso.
   */
  compraReciente(organizationId: string, now: Date): Promise<boolean>;
  /** Rechazos SEGUIDOS de recarga (desde el último cobro que no falló) y cuándo fue el último. */
  failedRecharges(organizationId: string): Promise<FallosDeRecarga>;
  createAttempt(input: { organizationId: string; subscriptionId: string | null; commerceOrder: string; amount: number; currency: string }): Promise<void>;
  markAttempt(commerceOrder: string, status: "pending" | "failed", providerRef: string | null, reason: string | null): Promise<void>;
  notify(
    organizationId: string,
    kind: "recharge_started" | "recharge_failed" | "recharge_cap_reached",
    data: Record<string, string | number | null | undefined>,
  ): Promise<void>;
  /** Una sola vez por mes y motivo (para no repetir el aviso de tope en cada tick). */
  firstTimeThisMonth(key: string): Promise<boolean>;
  /**
   * Excepción para la consola de operación (V2-8). OPCIONAL a propósito: el cobro no puede
   * depender de que exista, y los dobles de test de este módulo no la implementan.
   */
  raiseOps?(
    organizationId: string,
    input: { type: string; title: string; detail: string; dedupeKey: string; severity: "warning" | "critical" },
  ): Promise<void>;
}

export interface AutoRechargeResult {
  cobradas: number;
  motivos: Record<string, number>;
  /** Cobros emitidos sin respuesta de la pasarela: no se sabe si la tarjeta quedó cobrada. */
  sinRespuesta: number;
}

/**
 * Pasada de recarga automática. Devuelve cuántas se cobraron y por qué no se cobró el
 * resto (lo segundo es lo que se mira cuando un cliente reclama que se quedó sin saldo
 * teniendo la recarga activada).
 *
 * El resultado DEFINITIVO del cobro no llega acá: Flow confirma por webhook y ahí se
 * acredita el pack (el mismo camino idempotente que una compra manual). Lo que sí se hace
 * acá es dejar el intento registrado y avisarle al cliente.
 */
export async function runAutoRecharge(
  port: AutoRechargePort,
  providerFor: (organizationId: string) => Promise<SubscriptionProvider>,
  now: Date,
  urls: { confirmation: string; ret: string },
): Promise<AutoRechargeResult> {
  const out: AutoRechargeResult = { cobradas: 0, motivos: {}, sinRespuesta: 0 };
  const candidatos = await port.listCandidates();
  for (const c of candidatos) {
    const pack = c.cfg.packCode ? await port.packOf(c.cfg.packCode) : null;
    const decision = decidirRecarga({
      cfg: c.cfg,
      saldo: await port.balanceOf(c.organizationId),
      precioClp: pack?.priceClp ?? 0,
      gastadoEsteMesClp: await port.spentThisMonth(c.organizationId, now),
      tieneTarjeta: Boolean(c.customerRef),
      enVuelo: await port.hasPendingRecharge(c.organizationId),
      compraReciente: await port.compraReciente(c.organizationId, now),
      fallos: await port.failedRecharges(c.organizationId),
      now,
      moneda: c.currency,
    });
    out.motivos[decision] = (out.motivos[decision] ?? 0) + 1;

    // Se dejó de intentar: el cliente tiene que cambiar la tarjeta o recargar a mano, y
    // esto no puede quedar solo en un aviso que quizá no lea — es un cliente que paga y
    // cuyo bot se va a cortar cuando se le acabe la gracia. Una vez por mes, y además a la
    // cola de operación para que se vea en la consola.
    if (decision === "tarjeta_agotada") {
      if (await port.firstTimeThisMonth(`agotada:${c.organizationId}:${now.getUTCFullYear()}-${now.getUTCMonth()}`)) {
        await port.notify(c.organizationId, "recharge_failed", { reason: "tarjeta_agotada" }).catch(() => undefined);
        await port
          .raiseOps?.(c.organizationId, {
            type: "recarga_fallida",
            severity: "critical",
            title: "Recarga automática DETENIDA: la tarjeta falló 3 veces",
            detail: `Se dejó de reintentar tras ${MAX_FALLOS_SEGUIDOS} rechazos seguidos. El bot sigue con la gracia; hay que cambiar el medio de pago o recargar a mano.`,
            dedupeKey: `agotada:${now.getUTCFullYear()}-${now.getUTCMonth()}`,
          })
          .catch(() => undefined);
      }
      continue;
    }
    // Esperando tras un rechazo: sin aviso y sin ruido. El cliente ya se enteró cuando falló.
    if (decision === "espera_tras_fallo") continue;

    if (decision === "tope_mensual") {
      // Al llegar al tope se avisa UNA vez en el mes: el cliente tiene que poder subirlo o
      // recargar a mano antes de quedarse sin bot.
      if (await port.firstTimeThisMonth(`cap:${c.organizationId}:${now.getUTCFullYear()}-${now.getUTCMonth()}`)) {
        await port
          .notify(c.organizationId, "recharge_cap_reached", { monthlyCapClp: c.cfg.monthlyCapClp })
          .catch(() => undefined);
      }
      continue;
    }
    if (decision !== "cobrar" || !pack) continue;

    const commerceOrder = `${RECHARGE_ORDER_PREFIX}${c.organizationId}-${now.getTime()}`;
    await port.createAttempt({
      organizationId: c.organizationId,
      subscriptionId: c.subscriptionId,
      commerceOrder,
      amount: pack.priceClp,
      currency: c.currency,
    });

    let r;
    try {
      const provider = await providerFor(c.organizationId);
      r = await provider.charge({
        customerRef: c.customerRef!,
        amount: pack.priceClp,
        currency: c.currency,
        commerceOrder,
        subject: `${c.brandSubject} · ${pack.credits.toLocaleString("es-CL")} Créditos IA (recarga automática)`,
        urlConfirmation: urls.confirmation,
        urlReturn: urls.ret,
        // Lo que el webhook necesita para acreditar: el pack, con el prefijo "pkg:" que ya
        // usa la compra manual, y el monto esperado (el webhook rechaza si no calza).
        metadata: {
          organizationId: c.organizationId,
          planCode: `pkg:${pack.code}`,
          expectedAmount: String(pack.priceClp),
          autoRecharge: "1",
        },
      });
    } catch (err) {
      // NO SABEMOS SI SE COBRÓ, y eso es exactamente lo que se registra.
      //
      // Un `charge` que revienta por timeout o red puede haber entrado perfectamente en la
      // pasarela: la tarjeta quedó cobrada y lo que se perdió fue nuestra respuesta.
      // Marcarlo `failed` —como estaba— era AFIRMAR que no se cobró, y de esa afirmación
      // falsa salían tres cosas, las tres malas: el intento dejaba de contar contra el tope
      // mensual (que mide los exitosos y los en vuelo), soltaba la guarda de "un cobro a la
      // vez", y el tick siguiente volvía a cobrar. Con una pasarela que responde lento eso
      // es un cobro cada 15 minutos; y los tres primeros "rechazos" apagarían la recarga
      // automática de un cliente al que en realidad ya le cobramos tres veces.
      //
      // Queda PENDIENTE, que es la verdad: cuenta contra el tope, bloquea el próximo cobro
      // y espera. Si el cobro entró, el webhook lo cierra y acredita; si no entró, nadie
      // acredita nada y la ventana en vuelo libera la cuenta en unas horas.
      await port.markAttempt(commerceOrder, "pending", null, `sin_respuesta: ${(err as Error).message}`.slice(0, 200));
      // Y se avisa al DUEÑO, no al cliente: decirle "tu tarjeta falló" cuando puede estar
      // cobrada es mentirle, y si está cobrada además le van a llegar los créditos. Esto
      // necesita que una persona abra el panel de la pasarela y mire esa orden.
      await port
        .raiseOps?.(c.organizationId, {
          type: "recarga_sin_respuesta",
          severity: "critical",
          title: "Un cobro de recarga se emitió sin respuesta de la pasarela",
          detail:
            `La orden ${commerceOrder} por $${pack.priceClp.toLocaleString("es-CL")} se envió y la pasarela no respondió ` +
            `(${(err as Error).message}). NO se sabe si la tarjeta quedó cobrada: hay que buscar esa orden en el panel de ` +
            `Flow y, si está pagada, acreditar los ${pack.credits} créditos. Mientras tanto no se le vuelve a cobrar.`,
          dedupeKey: `sin_respuesta:${commerceOrder}`,
        })
        .catch(() => undefined);
      out.sinRespuesta++;
      continue;
    }

    if (!r.ok) {
      await port.markAttempt(commerceOrder, "failed", r.providerRef, r.reason);
      // Tarjeta rechazada: se avisa de inmediato. El bot no se corta todavía — le queda la
      // gracia, que es justo para esto.
      await port
        .notify(c.organizationId, "recharge_failed", { reason: r.reason ?? "rechazada", credits: pack.credits, amountClp: pack.priceClp })
        .catch(() => undefined);
      // Y el dueño se entera desde el PRIMER rechazo, no cuando ya se agotó la tarjeta: un
      // cobro que no pasa es un bot que se va a cortar en unos días.
      await port
        .raiseOps?.(c.organizationId, {
          type: "recarga_fallida",
          severity: "warning",
          title: "La tarjeta rechazó la recarga automática",
          detail: `Motivo: ${r.reason ?? "rechazada"}. Se reintenta en ${HORAS_ESPERA_TRAS_FALLO} h; tras ${MAX_FALLOS_SEGUIDOS} rechazos seguidos se deja de intentar.`,
          // Clave distinta de la del aviso de "se dejó de intentar": si fuera la misma, la
          // deduplicación taparía justo el aviso grave con el leve que llegó primero.
          dedupeKey: `fallo:${now.getUTCFullYear()}-${now.getUTCMonth()}`,
        })
        .catch(() => undefined);
      continue;
    }

    await port.markAttempt(commerceOrder, "pending", r.providerRef, null);
    await port
      .notify(c.organizationId, "recharge_started", { credits: pack.credits, amountClp: pack.priceClp, packName: pack.code })
      .catch(() => undefined);
    out.cobradas++;
  }
  return out;
}
