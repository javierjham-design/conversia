import { describe, expect, it } from "vitest";
import { summarize } from "../src/charging/cash.controller";

// Montos CON SIGNO (ingreso +, egreso −, reversa = −original). El neto del libro es la
// SUMA simple → la property "suma de asientos = total" se cumple por construcción.
const ingreso = (amount: number, method = "efectivo", status = "declarado") => ({ amount, method, status });
const egreso = (amount: number, method = "efectivo", status = "declarado") => ({ amount: -amount, method, status });

describe("F9 caja — summarize (libro append-only con signo)", () => {
  it("property: net === suma de montos", () => {
    const entries = [ingreso(40000), egreso(10000), ingreso(25000, "tarjeta"), egreso(5000, "transferencia")];
    const s = summarize(entries);
    expect(s.net).toBe(entries.reduce((a, e) => a + e.amount, 0));
    expect(s.net).toBe(50000);
  });

  it("reversa de un ingreso deja neto 0 (ingreso + su reversa)", () => {
    const orig = ingreso(40000);
    const reversa = { amount: -orig.amount, method: orig.method, status: orig.status }; // −original
    expect(summarize([orig, reversa]).net).toBe(0);
  });

  it("re-reversa (reversa de la reversa) vuelve a sumar el original", () => {
    const orig = ingreso(40000); // +40000
    const reversa = { amount: -orig.amount, method: orig.method, status: orig.status }; // −40000
    const reReversa = { amount: -reversa.amount, method: orig.method, status: orig.status }; // +40000
    expect(summarize([orig, reversa, reReversa]).net).toBe(40000);
  });

  it("separa conciliado (webhook) vs declarado (manual)", () => {
    const s = summarize([ingreso(30000, "link_flow", "conciliado"), ingreso(10000, "efectivo", "declarado")]);
    expect(s.conciliado).toBe(30000);
    expect(s.declarado).toBe(10000);
    expect(s.net).toBe(40000);
  });

  it("totales por método + efectivo para el cierre", () => {
    const s = summarize([ingreso(40000, "efectivo"), egreso(5000, "efectivo"), ingreso(25000, "tarjeta")]);
    expect(s.byMethod.efectivo).toBe(35000);
    expect(s.byMethod.tarjeta).toBe(25000);
    expect(s.efectivo).toBe(35000); // base para calcular la diferencia del cierre
  });

  it("cierre: diferencia = efectivo contado − efectivo del libro", () => {
    const s = summarize([ingreso(40000, "efectivo"), egreso(10000, "efectivo")]);
    const declaredCash = 28000; // el usuario contó 28.000
    expect(declaredCash - s.efectivo).toBe(-2000); // faltan 2.000 en caja
  });
});
