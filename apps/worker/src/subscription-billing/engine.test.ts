import { describe, expect, it } from "vitest";
import { applyOutcome, reconcilePending, runBillingCycle, type BillingPort, type EngineSub } from "./engine";
import { FakeSubscriptionProvider } from "./provider";
import { addMonths } from "./state-machine";

const T0 = new Date("2026-09-01T12:00:00Z");
const hoursAfter = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

function baseSub(over: Partial<EngineSub> = {}): EngineSub {
  return {
    id: "s1",
    organizationId: "org1",
    state: "ACTIVE",
    interval: "monthly",
    amount: 69900,
    currency: "CLP",
    subject: "Plan Starter",
    providerCustomerRef: "cus_1",
    dueAt: T0,
    periodEnd: T0,
    pastDueSince: null,
    retriesDone: 0,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

/** Puerto FALSO que registra efectos y guarda las suscripciones en memoria. */
function fakePort(subs: EngineSub[]) {
  const attempts: Array<{ commerceOrder: string; kind: string; n: number; status?: string; reason?: string; subId: string; providerRef?: string; createdAt?: Date }> = [];
  const excepciones: Array<{ type: string; title: string; detail: string; dedupeKey: string; severity: string }> = [];
  const notes: Array<{ orgId: string; kind: string }> = [];
  const successes: Array<{ id: string; periodEnd: Date }> = [];
  const failures: Array<{ id: string; retriesDone: number }> = [];
  const suspended: string[] = [];
  const port: BillingPort = {
    async listActionable() {
      return subs;
    },
    async createAttempt(sub, kind, n, commerceOrder) {
      if (attempts.some((a) => a.commerceOrder === commerceOrder)) throw new Error("duplicado");
      attempts.push({ commerceOrder, kind, n, subId: sub.id });
    },
    async markAttempt(commerceOrder, status) {
      const a = attempts.find((x) => x.commerceOrder === commerceOrder);
      if (a) a.status = status;
    },
    async applySuccess(sub, periodEnd) {
      successes.push({ id: sub.id, periodEnd });
    },
    async applyFailure(sub, _pastDueSince, retriesDone) {
      failures.push({ id: sub.id, retriesDone });
    },
    async suspend(sub) {
      suspended.push(sub.id);
    },
    async notify(orgId, kind) {
      notes.push({ orgId, kind });
    },
    async listPending() {
      // `providerRef` explícito: un intento al que se le fabrica el ref siempre tiene token y
      // el caso del cobro huérfano (sin referencia) no se podría escribir.
      return attempts
        .filter((a) => a.status === "pending")
        .map((a) => ({ commerceOrder: a.commerceOrder, providerRef: a.providerRef ?? (a.createdAt ? "" : "ref"), subscriptionId: a.subId, createdAt: a.createdAt }));
    },
    async abandonAttempt(commerceOrder, reason) {
      const a = attempts.find((x) => x.commerceOrder === commerceOrder && x.status === "pending");
      if (a) {
        a.status = "failed";
        a.reason = reason;
      }
    },
    async raiseOps(_orgId, input) {
      excepciones.push(input);
    },
    async pendingSubscriptionIds() {
      return new Set(attempts.filter((a) => a.status === "pending").map((a) => a.subId));
    },
    async getSub(subscriptionId) {
      return subs.find((s) => s.id === subscriptionId) ?? null;
    },
  };
  return { port, attempts, notes, successes, failures, suspended, excepciones };
}

async function providerFor(ok: boolean) {
  const p = new FakeSubscriptionProvider();
  p.scheduleCharge(ok);
  return async () => p;
}

describe("runBillingCycle — ciclo de cobro con adaptador falso", () => {
  it("ACTIVE con cobro vencido y tarjeta OK → cobra, renueva, avisa éxito", async () => {
    const f = fakePort([baseSub({ dueAt: T0, periodEnd: T0 })]);
    const r = await runBillingCycle(f.port, await providerFor(true), T0);
    expect(r.charged).toBe(1);
    expect(f.attempts[0].kind).toBe("auto");
    expect(f.attempts[0].status).toBe("succeeded");
    expect(f.successes[0].periodEnd).toEqual(addMonths(T0, 1));
    expect(f.notes.map((n) => n.kind)).toContain("payment_succeeded");
  });

  it("cobro rechazado → abre ventana (applyFailure) y avisa rechazo", async () => {
    const f = fakePort([baseSub({ dueAt: T0 })]);
    await runBillingCycle(f.port, await providerFor(false), T0);
    expect(f.failures[0].retriesDone).toBe(0);
    expect(f.notes.map((n) => n.kind)).toContain("payment_failed");
  });

  it("PAST_DUE con reintento a las +12 h → intento kind=retry", async () => {
    const sub = baseSub({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 0, dueAt: T0 });
    const f = fakePort([sub]);
    await runBillingCycle(f.port, await providerFor(false), hoursAfter(T0, 12));
    expect(f.attempts[0].kind).toBe("retry");
    expect(f.attempts[0].n).toBe(2);
  });

  it("PAST_DUE a las 48 h → suspende y avisa", async () => {
    const sub = baseSub({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 2 });
    const f = fakePort([sub]);
    const r = await runBillingCycle(f.port, await providerFor(true), hoursAfter(T0, 48));
    expect(r.suspended).toBe(1);
    expect(f.suspended).toEqual(["s1"]);
    expect(f.notes.map((n) => n.kind)).toContain("suspended");
    expect(f.attempts.length).toBe(0); // no se cobra al suspender
  });

  it("sin medio de pago no intenta cobrar", async () => {
    const f = fakePort([baseSub({ providerCustomerRef: null, dueAt: T0 })]);
    const r = await runBillingCycle(f.port, await providerFor(true), T0);
    expect(r.charged).toBe(0);
    expect(f.attempts.length).toBe(0);
  });

  it("cancelada cuyo período terminó → suspende (no cobra período nuevo)", async () => {
    const periodEnd = hoursAfter(T0, 240);
    const f = fakePort([baseSub({ cancelAtPeriodEnd: true, periodEnd, dueAt: periodEnd })]);
    const r = await runBillingCycle(f.port, await providerFor(true), periodEnd);
    expect(r.suspended).toBe(1);
    expect(f.attempts.length).toBe(0);
  });
});

describe("reconcilePending — cobros asíncronos de Flow y webhooks perdidos", () => {
  it("cobro asíncrono: queda pendiente en el ciclo y se aplica al reconciliar", async () => {
    const f = fakePort([baseSub({ dueAt: T0, periodEnd: T0 })]);
    // Adaptador en modo asíncrono (Flow collect): el charge deja el intento PENDIENTE.
    const p = new FakeSubscriptionProvider();
    p.scheduleCharge(true, null, true);
    const providerAsync = async () => p;
    await runBillingCycle(f.port, providerAsync, T0);
    expect(f.attempts[0].status).toBe("pending");
    expect(f.successes.length).toBe(0); // aún no aplicado
    // Reconciliación: reconsulta el estado (OK) y aplica el resultado.
    const r = await reconcilePending(f.port, providerAsync, hoursAfter(T0, 1));
    expect(r.reconciled).toBe(1);
    expect(f.successes.length).toBe(1);
    expect(f.notes.map((n) => n.kind)).toContain("payment_succeeded");
  });

  it("un intento SIN TOKEN y viejo se cierra y se alerta: el cobro de esa cuenta no queda apagado", async () => {
    // El espejo, en la mensualidad, del webhook perdido de las recargas. Un `collect` cuya
    // llamada HTTP murió antes de devolver el token deja un intento pendiente que nadie
    // puede reconsultar — y como "esta suscripción tiene un cobro en vuelo" lo veía, la
    // cuenta no se volvía a cobrar NUNCA, en silencio: servicio gratis para siempre.
    const f = fakePort([baseSub({ dueAt: T0, periodEnd: T0 })]);
    f.attempts.push({ commerceOrder: "sub-sub-1-1", kind: "auto", n: 1, status: "pending", subId: "s1", createdAt: T0 });
    const p = new FakeSubscriptionProvider();
    const r = await reconcilePending(f.port, async () => p, hoursAfter(T0, 7));

    expect(r.reconciled).toBe(0); // no se reconcilió nada: no había qué consultar
    expect(f.attempts[0].status).toBe("failed");
    // Y NO se toca el estado de la suscripción: no sabemos si el cobro entró, así que no se
    // la pone morosa ni se le renueva el período.
    expect(f.successes).toEqual([]);
    expect(f.failures).toEqual([]);
    expect(f.excepciones[0]).toMatchObject({ type: "cobro_sin_referencia", severity: "critical" });
  });

  it("un intento sin token RECIENTE se deja en paz (el cobro puede estar en curso)", async () => {
    const f = fakePort([baseSub({ dueAt: T0, periodEnd: T0 })]);
    f.attempts.push({ commerceOrder: "sub-sub-1-1", kind: "auto", n: 1, status: "pending", subId: "s1", createdAt: T0 });
    const p = new FakeSubscriptionProvider();
    await reconcilePending(f.port, async () => p, hoursAfter(T0, 1));
    expect(f.attempts[0].status).toBe("pending");
    expect(f.excepciones).toEqual([]);
  });

  it("GUARDIA: no re-cobra si ya hay un intento pendiente en vuelo (evita el loop de N cobros)", async () => {
    const f = fakePort([baseSub({ dueAt: T0, periodEnd: T0 })]);
    const p = new FakeSubscriptionProvider();
    p.scheduleCharge(true, null, true); // async: el primer cobro queda PENDIENTE
    const providerAsync = async () => p;
    await runBillingCycle(f.port, providerAsync, T0);
    expect(f.attempts.length).toBe(1);
    // Segundo tick con el cobro AÚN pendiente y la sub todavía vencida: NO debe re-cobrar.
    const r2 = await runBillingCycle(f.port, providerAsync, hoursAfter(T0, 1));
    expect(r2.charged).toBe(0);
    expect(f.attempts.length).toBe(1);
  });
});

describe("applyOutcome — resultado asíncrono (webhook / reconciliación)", () => {
  it("pago manual estando SUSPENDED → reactiva y avisa 'reactivated'", async () => {
    const sub = baseSub({ state: "SUSPENDED", pastDueSince: T0, retriesDone: 2, periodEnd: T0 });
    const f = fakePort([sub]);
    await applyOutcome(f.port, sub, "sub-s1-manual", true, null, hoursAfter(T0, 100));
    expect(f.successes[0].periodEnd).toEqual(addMonths(hoursAfter(T0, 100), 1)); // período fresco desde ahora
    expect(f.notes.map((n) => n.kind)).toContain("reactivated");
  });

  it("§9.4 si la RENOVACIÓN falla, el intento NO queda 'succeeded' (no se le re-cobra la tarjeta)", async () => {
    const sub = baseSub({ dueAt: T0, periodEnd: T0 });
    const f = fakePort([sub]);
    const port: BillingPort = {
      ...f.port,
      async applySuccess() {
        throw new Error("fallo al renovar (timeout / colisión de número de factura)");
      },
    };
    await port.createAttempt(sub, "auto", 1, "sub-s1-boom");
    await expect(applyOutcome(port, sub, "sub-s1-boom", true, null, T0)).rejects.toThrow();
    // Sigue PENDIENTE: la suscripción cuenta como "cobro en vuelo" y el próximo tick no
    // vuelve a cobrar. Antes se marcaba succeeded primero → cobrado sin renovar y re-cobro.
    expect(f.attempts[0].status).toBeUndefined();
    expect(f.notes.length).toBe(0);
  });
});
