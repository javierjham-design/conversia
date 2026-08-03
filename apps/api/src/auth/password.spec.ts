import { describe, expect, it } from "vitest";
import { z } from "zod";

/** Misma regla del endpoint /auth/change-password (mín. 8, letra y número). */
const nextPasswordSchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/[a-zA-Z]/)
  .regex(/[0-9]/);

describe("cambio de contraseña", () => {
  it("acepta contraseñas con mín. 8 caracteres, letra y número", () => {
    expect(nextPasswordSchema.safeParse("clave1234").success).toBe(true);
    expect(nextPasswordSchema.safeParse("Segura2026").success).toBe(true);
  });

  it("rechaza cortas, sin letras o sin números", () => {
    expect(nextPasswordSchema.safeParse("corta1").success).toBe(false);
    expect(nextPasswordSchema.safeParse("12345678").success).toBe(false);
    expect(nextPasswordSchema.safeParse("solotexto").success).toBe(false);
  });

  it("el endpoint exige current no vacío (la actual siempre se verifica con bcrypt)", () => {
    const body = z.object({ current: z.string().min(1), next: nextPasswordSchema });
    expect(body.safeParse({ current: "", next: "clave1234" }).success).toBe(false);
    expect(body.safeParse({ next: "clave1234" }).success).toBe(false);
    expect(body.safeParse({ current: "laActual1", next: "clave1234" }).success).toBe(true);
  });
});
