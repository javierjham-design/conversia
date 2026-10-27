import { describe, expect, it } from "vitest";
import { leerRetorno } from "./cobros-retorno";

/**
 * Lectura del retorno de la pasarela en /cobros. Los URLs los arma la API por marca
 * (`billingReturnUrls`); acá se fija que la pantalla entienda TODAS las formas en que el
 * cliente puede volver, incluidas las marcas que agregan las pasarelas encima.
 */
describe("leerRetorno", () => {
  it("sin query (o con query ajena) no muestra nada", () => {
    expect(leerRetorno("")).toBeNull();
    expect(leerRetorno("?")).toBeNull();
    expect(leerRetorno("?utm_source=mail")).toBeNull();
  });

  it("los retornos que arma la API para Conversia", () => {
    expect(leerRetorno("?pago=ok")).toBe("pago-ok");
    expect(leerRetorno("?pago=cancelado")).toBe("pago-cancelado");
    expect(leerRetorno("?card=1")).toBe("tarjeta");
  });

  it("tolera la marca que agrega la pasarela sobre el retorno de la marca", () => {
    // Flow/Stripe/Lemon pegan ?paid=1 y el mock ?mock_session=… al successUrl.
    expect(leerRetorno("?pago=ok&paid=1")).toBe("pago-ok");
    expect(leerRetorno("?pago=ok&mock_session=mock_cs_1")).toBe("pago-ok");
    expect(leerRetorno("?pago=cancelado&paid=1")).toBe("pago-cancelado");
  });

  it("reconoce el pago aunque solo venga la marca de la pasarela (retorno de TuBot o manual)", () => {
    expect(leerRetorno("?paid=1")).toBe("pago-ok");
    expect(leerRetorno("?mock_session=mock_cs_1")).toBe("pago-ok");
  });

  it("la tarjeta tiene prioridad: ese retorno hay que confirmarlo contra la API", () => {
    expect(leerRetorno("?card=1&pago=ok")).toBe("tarjeta");
    expect(leerRetorno("?card=1&paid=1")).toBe("tarjeta");
  });

  it("valores inesperados no se interpretan como pago", () => {
    expect(leerRetorno("?pago=")).toBeNull();
    expect(leerRetorno("?pago=rechazado")).toBeNull();
    expect(leerRetorno("?card=0")).toBeNull();
    expect(leerRetorno("?paid=0")).toBeNull();
  });
});
