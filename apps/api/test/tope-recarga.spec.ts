import { describe, expect, it } from "vitest";
import { MAX_RECARGAS_MES } from "@conversia/agents";
import { revisarTope, techoDelTope } from "../src/billing/tope-recarga";

/**
 * EL TOPE DE LA RECARGA AUTOMÁTICA.
 *
 * Es la cifra con la que el cliente autoriza que le cobremos a la tarjeta sin que vuelva a
 * apretar nada. Lo único que la limitaba era el `max(100000000)` del validador: un decimal de
 * más, un bug de la pantalla o una llamada directa a la API dejaban autorizados cien millones
 * de pesos. Y el consentimiento que dio por $249.900 seguía valiendo para la cifra nueva,
 * porque subir el tope no pedía nada.
 */

const PRECIO = 24_990;
const base = { enabled: true, precioPackClp: PRECIO, consintio: false };

describe("el techo del tope", () => {
  it("son 10 recargas del pack elegido", () => {
    expect(techoDelTope(PRECIO)).toBe(PRECIO * MAX_RECARGAS_MES);
  });

  it("un tope absurdo se rechaza (el caso de los cien millones)", () => {
    expect(revisarTope({ ...base, pedido: 100_000_000, previo: 249_900, consintio: true })).toBe("sobre_el_techo");
  });

  it("el tope de fábrica entra justo (10 recargas exactas)", () => {
    expect(revisarTope({ ...base, pedido: PRECIO * MAX_RECARGAS_MES, previo: PRECIO * MAX_RECARGAS_MES })).toBeNull();
    expect(revisarTope({ ...base, pedido: PRECIO * MAX_RECARGAS_MES + 1, previo: 0, consintio: true })).toBe("sobre_el_techo");
  });

  it("con un pack más caro el techo sube con él (no es una cifra en pesos escrita a mano)", () => {
    expect(revisarTope({ ...base, precioPackClp: 149_900, pedido: 1_499_000, previo: 0, consintio: true })).toBeNull();
  });

  it("sin pack configurado no hay techo que aplicar (ese tope no autoriza ningún cobro)", () => {
    expect(revisarTope({ ...base, precioPackClp: null, pedido: 5_000_000, previo: 0, consintio: true })).toBeNull();
  });
});

describe("subir el tope exige volver a aceptar", () => {
  it("subirlo sin aceptar se rechaza", () => {
    expect(revisarTope({ ...base, pedido: 200_000, previo: 100_000 })).toBe("sube_sin_consentir");
  });

  it("subirlo aceptando se permite", () => {
    expect(revisarTope({ ...base, pedido: 200_000, previo: 100_000, consintio: true })).toBeNull();
  });

  it("BAJARLO nunca pide nada: siempre es a favor del cliente", () => {
    expect(revisarTope({ ...base, pedido: 50_000, previo: 100_000 })).toBeNull();
  });

  it("dejarlo igual tampoco pide nada", () => {
    expect(revisarTope({ ...base, pedido: 100_000, previo: 100_000 })).toBeNull();
  });

  it("la primera vez (sin tope previo) la aceptación la pide el flujo de encendido, no esta regla", () => {
    // Al activar la recarga ya hay un consentimiento obligatorio aparte (`resolveConsent`).
    // Esta regla cubre solo el caso de SUBIR un tope que ya existía.
    expect(revisarTope({ ...base, pedido: 100_000, previo: undefined })).toBeNull();
  });

  it("con la recarga APAGADA no se valida nada: el tope guardado no autoriza cobros", () => {
    expect(revisarTope({ ...base, enabled: false, pedido: 100_000_000, previo: 1 })).toBeNull();
  });

  it("una petición que no trae tope conserva el anterior y no dispara ninguna regla", () => {
    expect(revisarTope({ ...base, pedido: undefined, previo: 100_000 })).toBeNull();
  });
});
