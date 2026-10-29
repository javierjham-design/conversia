/**
 * CRE — AUDITORÍA DEL CONTADOR DE CRÉDITOS (pura, sin I/O).
 *
 * El medidor ya tiene tests, pero todos prueban que la fórmula calcula bien. Lo que nadie
 * verificaba es lo otro: que **cada respuesta que el bot dio de verdad quedó cobrada, una
 * sola vez y por el monto exacto**. Eso no es aritmética de una función, es una propiedad
 * de los datos, y se rompe por donde la fórmula no mira: un reintento que cobra dos veces,
 * un débito que se pierde en una carrera, un turno que respondió gratis porque el débito
 * falló y el `catch` lo dejó pasar (`agent-turn.ts`: el cobro nunca frena la respuesta).
 *
 * La comparación se hace contra DOS fuentes escritas por caminos distintos:
 *
 *   - `ai_requests` — la escribe el orquestador al persistir el turno: modelo que respondió,
 *     tokens reales y costo USD. Es el HECHO: el bot respondió y nos costó esto.
 *   - `conversation_credit_ledger` (refType `turn`) — la escribe el cobrador. Es el COBRO.
 *
 * Si el cobrador aplica mal la política, su propio registro en `usage_events` lo repetiría
 * mal y cuadraría consigo mismo; `ai_requests` no, porque no pasa por la política. Por eso
 * la auditoría parte del hecho y no del cobro.
 *
 * Es pura para poder probar cada veredicto con casos armados a mano (incluidos los que
 * jamás se logran provocar en un stack real, como un doble cobro), y para que la corra
 * igual el script que mira producción, la prueba de carga y el test.
 */
import { creditsForTurn, type CreditPolicy } from "./credit-formula.js";

/** Un turno tal como lo dejó el orquestador en `ai_requests`. */
export interface TurnoAuditado {
  /** `ai_requests.id` — el mismo valor que sella el débito (`refId`). */
  turnId: string;
  organizationId: string;
  /** Modelo que RESPONDIÓ (no la etiqueta configurada). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Costo real del turno en USD, para el margen. */
  costUsd?: number;
  /** `ok` | `error` | `refusal` — un turno con error suele traer 0 tokens. */
  status?: string;
}

/** Los asientos de débito encontrados para ese turno (normalmente uno). */
export interface DebitosDelTurno {
  /** `delta` de cada asiento, tal como está en el libro (negativo). */
  deltas: number[];
}

export type VeredictoTurno =
  /** Cobrado exactamente lo que manda la fórmula. */
  | "ok"
  /** Turno sin tokens (proveedor caído, modo degradado) y sin cobro: correcto. */
  | "no_cobrable"
  /** Respondió y no se cobró nada. Regalamos el servicio. */
  | "sin_cobrar"
  /** Se cobró menos de lo que corresponde. */
  | "cobrado_de_menos"
  /** Se cobró más de lo que corresponde: le sacamos créditos de más al cliente. */
  | "cobrado_de_mas"
  /** Más de un asiento para el MISMO turno: el reintento cobró dos veces. */
  | "doble_cobro";

export interface AuditoriaTurno {
  turnId: string;
  organizationId: string;
  veredicto: VeredictoTurno;
  /** Créditos que manda la fórmula para este turno. */
  esperado: number;
  /** Créditos efectivamente debitados (suma de los asientos). */
  cobrado: number;
  /** cobrado − esperado. Positivo = de más al cliente; negativo = regalado. */
  diferencia: number;
  asientos: number;
  model: string;
  tokens: number;
}

/** Veredictos que significan que la plata no cuadra. */
export const VEREDICTOS_MALOS: VeredictoTurno[] = ["sin_cobrar", "cobrado_de_menos", "cobrado_de_mas", "doble_cobro"];

/**
 * Audita UN turno contra sus asientos.
 *
 * El doble cobro se mira ANTES del monto: dos asientos que suman el doble del esperado
 * darían "cobrado_de_mas", y eso esconde la causa. Son problemas distintos —uno es un
 * precio mal calculado, el otro es la idempotencia rota— y se arreglan en lugares
 * distintos, así que el veredicto tiene que nombrar el que importa.
 */
export function auditarTurno(turno: TurnoAuditado, debitos: DebitosDelTurno, policy?: CreditPolicy): AuditoriaTurno {
  const tokens = Math.max(0, Number(turno.inputTokens) || 0) + Math.max(0, Number(turno.outputTokens) || 0);
  const esperado = creditsForTurn({ model: turno.model, tokens, policy }).credits;
  const cobrado = debitos.deltas.reduce((a, d) => a + Math.abs(Number(d) || 0), 0);
  const asientos = debitos.deltas.length;

  let veredicto: VeredictoTurno;
  if (asientos > 1) veredicto = "doble_cobro";
  else if (esperado === 0 && cobrado === 0) veredicto = "no_cobrable";
  else if (cobrado === 0) veredicto = "sin_cobrar";
  else if (cobrado > esperado) veredicto = "cobrado_de_mas";
  else if (cobrado < esperado) veredicto = "cobrado_de_menos";
  else veredicto = "ok";

  return {
    turnId: turno.turnId,
    organizationId: turno.organizationId,
    veredicto,
    esperado,
    cobrado,
    diferencia: cobrado - esperado,
    asientos,
    model: turno.model,
    tokens,
  };
}

export interface ResumenAuditoria {
  turnos: number;
  porVeredicto: Record<VeredictoTurno, number>;
  /** Créditos que deberían haberse cobrado por todos los turnos del período. */
  esperado: number;
  /** Créditos efectivamente cobrados. */
  cobrado: number;
  /** Créditos regalados (los que faltan por cobrar). */
  regalados: number;
  /** Créditos cobrados de más al cliente. */
  deMas: number;
  /** true = todo cuadra al crédito. */
  cuadra: boolean;
}

const VACIO: Record<VeredictoTurno, number> = {
  ok: 0,
  no_cobrable: 0,
  sin_cobrar: 0,
  cobrado_de_menos: 0,
  cobrado_de_mas: 0,
  doble_cobro: 0,
};

/**
 * Totales. `regalados` y `deMas` se cuentan por separado y NO se netean: si un turno se
 * cobró 10 de más y otro se dejó de cobrar 10, el total "cuadra" en cero y los dos
 * problemas desaparecen del informe. Son dos agujeros distintos y los dos pierden plata
 * (uno nuestra, otro de la confianza del cliente).
 */
export function resumirAuditoria(items: AuditoriaTurno[]): ResumenAuditoria {
  const porVeredicto = { ...VACIO };
  let esperado = 0;
  let cobrado = 0;
  let regalados = 0;
  let deMas = 0;
  for (const i of items) {
    porVeredicto[i.veredicto]++;
    esperado += i.esperado;
    cobrado += i.cobrado;
    if (i.diferencia < 0) regalados += -i.diferencia;
    if (i.diferencia > 0) deMas += i.diferencia;
  }
  return {
    turnos: items.length,
    porVeredicto,
    esperado,
    cobrado,
    regalados,
    deMas,
    cuadra: regalados === 0 && deMas === 0 && porVeredicto.doble_cobro === 0,
  };
}

// ---------------------------------------------------------------------------
// Invariantes del monedero
// ---------------------------------------------------------------------------

export interface EstadoMonedero {
  organizationId: string;
  /** Suma de `remaining` de los lotes VIGENTES. */
  lotesVigentes: number;
  /** Suma de `remaining` de los lotes ya vencidos que el barrido todavía no cerró. */
  lotesVencidosSinBarrer: number;
  /** `conversation_wallets.grace_used`. */
  graciaUsada: number;
  /** Suma de TODOS los `delta` del libro de la organización. */
  sumaDelLibro: number;
  /** `balance_after` del último asiento del libro. */
  ultimoBalanceAfter: number | null;
  /** Lotes con `remaining` negativo (nunca debería haber). */
  lotesNegativos: number;
  /** Tope de gracia de la política vigente. */
  graciaLimite: number;
}

export interface InvariantesMonedero {
  organizationId: string;
  /** Saldo neto que ve el cliente. */
  saldo: number;
  /**
   * El libro explica el saldo: sumar todos los asientos da el saldo, descontando los lotes
   * vencidos que el barrido no cerró todavía (esos ya no son saldo pero su asiento de
   * expiración aún no existe).
   */
  libroCuadra: boolean;
  /** El último asiento dice el mismo saldo que tiene hoy el monedero. */
  ultimoAsientoCuadra: boolean;
  /** La gracia no pasó del tope: nadie puede operar gratis más allá del colchón. */
  graciaDentroDelLimite: boolean;
  /** Ningún lote quedó en negativo. */
  sinLotesNegativos: boolean;
  ok: boolean;
  /** Diferencia entre lo que dice el libro y el saldo real (0 = cuadra). */
  descuadre: number;
}

/**
 * Las cuatro cosas que tienen que ser verdad en el monedero de cualquier cliente, siempre.
 *
 * `libroCuadra` es la más importante y la que ningún test unitario puede dar: cada crédito
 * que entró o salió tiene que tener un asiento que lo explique. Si el libro no cuadra con
 * el saldo, hay un camino que mueve créditos sin anotarlos, y ese camino es por donde se
 * va la plata sin que nadie lo vea.
 */
export function verificarMonedero(e: EstadoMonedero): InvariantesMonedero {
  const saldo = e.lotesVigentes - e.graciaUsada;
  // El libro suma los lotes tal como se acreditaron; los vencidos sin barrer ya salieron
  // del saldo pero todavía no tienen su asiento de expiración.
  const segunLibro = e.sumaDelLibro - e.lotesVencidosSinBarrer;
  const descuadre = segunLibro - saldo;
  const libroCuadra = descuadre === 0;
  const ultimoAsientoCuadra = e.ultimoBalanceAfter == null || e.ultimoBalanceAfter === saldo;
  const graciaDentroDelLimite = e.graciaUsada <= e.graciaLimite;
  const sinLotesNegativos = e.lotesNegativos === 0;
  return {
    organizationId: e.organizationId,
    saldo,
    libroCuadra,
    ultimoAsientoCuadra,
    graciaDentroDelLimite,
    sinLotesNegativos,
    ok: libroCuadra && ultimoAsientoCuadra && graciaDentroDelLimite && sinLotesNegativos,
    descuadre,
  };
}

// ---------------------------------------------------------------------------
// Costo real de un crédito (la rentabilidad)
// ---------------------------------------------------------------------------

/**
 * Lo que nos CUESTA producir un crédito, en pesos, según el consumo real.
 *
 * Es el número del que cuelga todo el modelo de precios: el catálogo supone $2,1 por
 * crédito y de ahí sale que la recarga de 420 a $24.990 deje >300% sobre el costo. Si el
 * costo real sube —clientes que conversan más largo, un modelo más caro de lo previsto— el
 * margen se cae sin que nadie se entere hasta la factura del proveedor.
 *
 * Vive acá, y no en el reporte del super admin, porque ahora lo necesitan los dos: el
 * reporte mensual y la auditoría del contador. Tenerlo dos veces es exactamente cómo
 * aparecen dos pantallas diciendo números distintos del mismo mes.
 */
export function costoPorCreditoClp(input: { costoIaUsd: number; creditos: number; clpPorUsd: number }): number {
  if (!(input.creditos > 0)) return 0;
  return Math.round(((Math.max(0, input.costoIaUsd) * input.clpPorUsd) / input.creditos) * 100) / 100;
}

/** Margen sobre el COSTO de un crédito (la meta del dueño es ≥300%). `null` sin costo medido. */
export function margenSobreCostoPct(input: { precioCreditoClp: number; costoPorCreditoClp: number }): number | null {
  if (!(input.costoPorCreditoClp > 0)) return null;
  return Math.round(((input.precioCreditoClp - input.costoPorCreditoClp) / input.costoPorCreditoClp) * 100);
}
