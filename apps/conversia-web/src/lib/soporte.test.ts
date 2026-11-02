import { afterEach, describe, expect, it } from "vitest";
import { contactoDeSoporte } from "./assistant";

/**
 * Hallazgo del dueño: con Convi caído, el mensaje decía "escríbele a soporte"… dentro de la
 * ventana que ES el soporte. Sin número, sin correo, sin botón. Un callejón sin salida en el
 * momento exacto en que algo ya había fallado.
 *
 * La regla que esto fija: SIEMPRE hay un canal. Nunca `null`, nunca una cadena vacía.
 */
const original = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
  else process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = original;
});

describe("contactoDeSoporte", () => {
  it("sin WhatsApp configurado cae a correo, no a la nada", () => {
    delete process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
    const c = contactoDeSoporte();
    expect(c.canal).toBe("correo");
    expect(c.url.startsWith("mailto:soporte@conversia.cl")).toBe(true);
    expect(c.etiqueta.length).toBeGreaterThan(0);
  });

  it("con WhatsApp configurado, ese es el canal", () => {
    process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = "56912345678";
    const c = contactoDeSoporte();
    expect(c.canal).toBe("whatsapp");
    expect(c.url).toContain("https://wa.me/56912345678");
  });

  it("el contexto viaja escapado en el mensaje (no rompe la URL)", () => {
    process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = "56912345678";
    const c = contactoDeSoporte("Convi no responde (estaba en /cobros)");
    expect(c.url).toContain(encodeURIComponent("Convi no responde (estaba en /cobros)"));
    expect(c.url).not.toContain(" ");
  });

  it("pase lo que pase devuelve una URL utilizable", () => {
    for (const wa of ["", "56912345678"]) {
      if (wa) process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP = wa;
      else delete process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
      expect(contactoDeSoporte().url).toMatch(/^(https:\/\/wa\.me\/|mailto:)/);
    }
  });
});
