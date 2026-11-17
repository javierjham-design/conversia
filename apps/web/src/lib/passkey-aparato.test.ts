import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convieneSugerirPasskey,
  hayPasskeyEnEsteAparato,
  noOfrecerPasskeyEnEsteAparato,
  olvidarPasskeyEnEsteAparato,
  recordarPasskeyEnEsteAparato,
} from "./passkey-aparato";

/**
 * P4 — la memoria por aparato del passkey. Lo que se encierra acá:
 *
 * 1. **Que un almacenamiento que EXPLOTA no tumbe la pantalla.** En ventana privada (y con los
 *    datos del sitio bloqueados) tocar `localStorage` puede tirar excepción, no devolver null.
 *    Si estas funciones propagan, la que se cae es la pantalla de LOGIN, que es justo la que
 *    nadie puede arreglar desde un teléfono. El default sin almacenamiento tiene que ser el
 *    conservador: "no hay passkey acá" y "sí, conviene ofrecerlo".
 * 2. **Que «Ahora no» aguante el cierre del navegador.** Con `sessionStorage` el aviso volvería
 *    en cada visita a quien ya dijo que no, y así es como la gente deja de leer los avisos.
 * 3. **Que inscribir borre el «Ahora no»**: si lo activó, la pregunta ya está contestada.
 */

/** `localStorage` de juguete, con un interruptor para hacerlo fallar como el real. */
function almacenamientoFalso(opts: { explota?: boolean } = {}) {
  const datos = new Map<string, string>();
  return {
    datos,
    api: {
      getItem(k: string) {
        if (opts.explota) throw new Error("SecurityError: acceso denegado");
        return datos.has(k) ? datos.get(k)! : null;
      },
      setItem(k: string, v: string) {
        if (opts.explota) throw new Error("QuotaExceededError");
        datos.set(k, v);
      },
      removeItem(k: string) {
        if (opts.explota) throw new Error("SecurityError: acceso denegado");
        datos.delete(k);
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("con almacenamiento normal", () => {
  it("de entrada no hay passkey y sí conviene sugerirlo", () => {
    vi.stubGlobal("localStorage", almacenamientoFalso().api);
    expect(hayPasskeyEnEsteAparato()).toBe(false);
    expect(convieneSugerirPasskey()).toBe(true);
  });

  it("recordar lo deja anotado y deja de sugerirlo", () => {
    vi.stubGlobal("localStorage", almacenamientoFalso().api);
    recordarPasskeyEnEsteAparato();
    expect(hayPasskeyEnEsteAparato()).toBe(true);
    expect(convieneSugerirPasskey()).toBe(false);
  });

  it("«Ahora no» calla la sugerencia SIN decir que hay un passkey", () => {
    vi.stubGlobal("localStorage", almacenamientoFalso().api);
    noOfrecerPasskeyEnEsteAparato();
    expect(convieneSugerirPasskey()).toBe(false);
    // Clave: el login NO debe poner Face ID de puerta principal solo porque se rechazó el aviso.
    expect(hayPasskeyEnEsteAparato()).toBe(false);
  });

  it("inscribirlo después de haber dicho «Ahora no» borra ese rechazo", () => {
    const falso = almacenamientoFalso();
    vi.stubGlobal("localStorage", falso.api);
    noOfrecerPasskeyEnEsteAparato();
    recordarPasskeyEnEsteAparato();
    expect([...falso.datos.keys()]).toEqual(["passkeyEnEsteAparato"]);
  });

  it("olvidar (cuenta sin aparatos) devuelve el login a correo y contraseña", () => {
    vi.stubGlobal("localStorage", almacenamientoFalso().api);
    recordarPasskeyEnEsteAparato();
    olvidarPasskeyEnEsteAparato();
    expect(hayPasskeyEnEsteAparato()).toBe(false);
    // Y vuelve a ofrecerse: quitó todos sus aparatos, puede querer activar este.
    expect(convieneSugerirPasskey()).toBe(true);
  });
});

describe("cuando el almacenamiento TIRA EXCEPCIÓN (ventana privada)", () => {
  it("ninguna de las cuatro funciones propaga el error", () => {
    const { api } = almacenamientoFalso({ explota: true });
    vi.stubGlobal("localStorage", api);
    // Control de que el doble realmente falla: si no, este test no prueba nada.
    expect(() => api.getItem("x")).toThrow();
    expect(() => recordarPasskeyEnEsteAparato()).not.toThrow();
    expect(() => olvidarPasskeyEnEsteAparato()).not.toThrow();
    expect(() => noOfrecerPasskeyEnEsteAparato()).not.toThrow();
    expect(() => hayPasskeyEnEsteAparato()).not.toThrow();
    expect(() => convieneSugerirPasskey()).not.toThrow();
  });

  it("y los valores por defecto son los conservadores", () => {
    vi.stubGlobal("localStorage", almacenamientoFalso({ explota: true }).api);
    expect(hayPasskeyEnEsteAparato()).toBe(false); // no se promete una puerta que puede no existir
    expect(convieneSugerirPasskey()).toBe(true); // se ofrece; molestar es mejor que esconderlo
  });
});

describe("sin `localStorage` definido (SSR / render en servidor)", () => {
  it("tampoco explota", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => hayPasskeyEnEsteAparato()).not.toThrow();
    expect(() => convieneSugerirPasskey()).not.toThrow();
    expect(() => recordarPasskeyEnEsteAparato()).not.toThrow();
    expect(hayPasskeyEnEsteAparato()).toBe(false);
  });
});
