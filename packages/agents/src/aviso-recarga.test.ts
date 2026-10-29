import { describe, expect, it } from "vitest";
import { queVaAPasarConElSaldo } from "./aviso-recarga";

/**
 * EL AVISO DE SALDO BAJO TIENE QUE DECIR QUÉ VA A PASAR.
 *
 * "Te queda el 10%" significa cosas muy distintas según cómo esté el cobro: con recarga
 * automática y tarjeta de crédito no pasa nada; con una de débito el cobro queda colgado y el
 * bot se pausa; sin tarjeta hay que ir a pagar. El cliente no puede deducir eso de un
 * porcentaje, y el momento de decírselo es mientras todavía le queda saldo para arreglarlo.
 */

const base = { recargaActiva: false, tieneTarjeta: true, tarjetaApta: null as boolean | null };

describe("qué le va a pasar al saldo", () => {
  it("recarga activa y tarjeta que sirve → no tiene que hacer nada", () => {
    const f = queVaAPasarConElSaldo({ ...base, recargaActiva: true, tarjetaApta: true });
    expect(f).toContain("se va a encargar");
  });

  it("recarga activa y tarjeta de DÉBITO → se le dice que NO va a funcionar", () => {
    // El estado que más importa y el que menos se ve: el cliente cree que está cubierto y no
    // lo está. Si el aviso dijera "tu recarga se va a encargar", se enteraría cuando el bot
    // ya se pausó.
    const f = queVaAPasarConElSaldo({ ...base, recargaActiva: true, tarjetaApta: false });
    expect(f).toContain("NO vamos a poder cobrarla");
    expect(f).toContain("CRÉDITO");
    expect(f).not.toContain("se va a encargar");
  });

  it("recarga activa pero con el TOPE alcanzado → tampoco se va a cobrar", () => {
    const f = queVaAPasarConElSaldo({ ...base, recargaActiva: true, tarjetaApta: true, topeAlcanzado: true });
    expect(f).toContain("tope mensual");
    expect(f).not.toContain("se va a encargar");
  });

  it("la tarjeta no apta manda sobre el tope: es el problema más grave de los dos", () => {
    const f = queVaAPasarConElSaldo({ ...base, recargaActiva: true, tarjetaApta: false, topeAlcanzado: true });
    expect(f).toContain("NO vamos a poder cobrarla");
  });

  it("sin tarjeta registrada → registrar una de crédito o recargar a mano", () => {
    const f = queVaAPasarConElSaldo({ ...base, tieneTarjeta: false, recargaActiva: true, tarjetaApta: true });
    expect(f).toContain("no tienes una tarjeta registrada");
  });

  it("con tarjeta y SIN recarga automática → se le ofrece activarla", () => {
    const f = queVaAPasarConElSaldo(base);
    expect(f).toContain("No tienes la recarga automática activada");
    expect(f).toContain("cortesía");
  });

  it("sin recarga Y con tarjeta de débito → las dos cosas, en una frase", () => {
    const f = queVaAPasarConElSaldo({ ...base, tarjetaApta: false });
    expect(f).toContain("no permite cobros automáticos");
    expect(f).toContain("a mano");
  });

  it("nunca sale vacío ni con un undefined dentro", () => {
    for (const recargaActiva of [true, false]) {
      for (const tieneTarjeta of [true, false]) {
        for (const tarjetaApta of [true, false, null]) {
          for (const topeAlcanzado of [true, false, undefined]) {
            const f = queVaAPasarConElSaldo({ recargaActiva, tieneTarjeta, tarjetaApta, topeAlcanzado });
            expect(f.length).toBeGreaterThan(40);
            expect(f).not.toContain("undefined");
          }
        }
      }
    }
  });
});
