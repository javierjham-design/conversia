import { describe, expect, it } from "vitest";
import { brandOf, BRANDS, messagingFuseKeys, resolveBrandCap } from "@conversia/config";
import { getEnv } from "@conversia/config";
import { trialWindowFor, TRIAL_DAYS, TRIAL_PURGE_DAYS } from "../src/auth/auth.service";
import { operatorMayAccess } from "../src/platform/platform-policy";

/**
 * §6.10 — "TuBot SIN CAMBIOS".
 *
 * La regla que manda sobre todo el plan de correcciones es que TuBot no se toca: atiende
 * clientes reales 24/7 y cualquier cambio suyo es un incidente, no una mejora. Cada etapa
 * promete eso en el PR; este archivo lo convierte en algo que el CI comprueba.
 *
 * No es un test de "funciona": es un test de "sigue igual". Si algo de acá se pone rojo,
 * la pregunta no es cómo arreglar el test.
 */
describe("§6.10 — TuBot sigue igual", () => {
  it("la prueba de TuBot sigue siendo 7 días + purga a los 14", () => {
    expect(TRIAL_DAYS).toBe(7);
    expect(TRIAL_PURGE_DAYS).toBe(14);
    const ahora = new Date("2026-10-27T12:00:00.000Z");
    const t = trialWindowFor("tubot", ahora);
    expect(t).not.toBeNull();
    expect(t!.startedAt).toBe(ahora.toISOString());
    expect(t!.endsAt).toBe("2026-11-03T12:00:00.000Z"); // +7 días
    expect(t!.purgeAt).toBe("2026-11-10T12:00:00.000Z"); // +14 días
    expect(t!.state).toBe("active");
  });

  it("una org sin marca se comporta como TuBot (cuentas históricas)", () => {
    const ahora = new Date("2026-10-27T12:00:00.000Z");
    expect(trialWindowFor(null, ahora)).toEqual(trialWindowFor("tubot", ahora));
    expect(trialWindowFor(undefined, ahora)).toEqual(trialWindowFor("tubot", ahora));
  });

  it("Conversia NO usa el trial de autoservicio (nace pendiente de implementación)", () => {
    expect(trialWindowFor("conversia", new Date())).toBeNull();
  });

  it("el remitente de correo de TuBot sigue saliendo de RESEND_FROM", () => {
    // Conversia tiene su remitente fijo; TuBot conserva el de la variable de entorno.
    expect(brandOf({ brand: "tubot" }).mailFrom).toBe(getEnv().RESEND_FROM);
    expect(brandOf(null).mailFrom).toBe(getEnv().RESEND_FROM);
    expect(brandOf({ brand: "conversia" }).mailFrom).not.toBe(getEnv().RESEND_FROM);
  });

  it("el fusible de TuBot sigue contando en las MISMAS claves de Redis", () => {
    // Si estas claves cambiaran, TuBot perdería el contador del día y el estado del
    // fusible a mitad de jornada.
    const d = "2026-10-27";
    const k = messagingFuseKeys("tubot", d);
    expect(k.templateCounter).toBe("msgcap:g:2026-10-27");
    expect(k.templateFuse).toBe("msgcap:fuse:2026-10-27");
    expect(k.templateAlerted).toBe("msgcap:fuse-alerted:2026-10-27");
    expect(k.serviceCounter).toBe("msgcap:svc:g:2026-10-27");
    expect(k.serviceFuse).toBe("msgcap:svc-fuse:2026-10-27");
    expect(k.serviceAlerted).toBe("msgcap:svc-fuse-alerted:2026-10-27");
  });

  it("TuBot sigue heredando el techo que ya está configurado (clave sin marca)", () => {
    expect(resolveBrandCap("tubot", { legacy: 1500, fallback: 99 })).toBe(1500);
  });

  it("la marca `tubot` existe y es la base del catálogo de marcas", () => {
    expect(BRANDS.tubot).toBeTruthy();
    expect(BRANDS.tubot.key).toBe("tubot");
  });

  it("el rol de plataforma de TuBot (owner/admin) no se vio afectado por la denylist", () => {
    // La denylist es del rol OPERADOR; el super admin pasa todo. Se comprueba que
    // `operatorMayAccess` sigue siendo una decisión de RUTA, no de marca.
    expect(operatorMayAccess("/platform/organizations/org_1/config")).toBe(true);
    expect(operatorMayAccess("/platform/plans")).toBe(false);
  });
});
