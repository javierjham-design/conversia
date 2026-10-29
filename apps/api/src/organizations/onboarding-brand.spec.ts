import { describe, it, expect } from "vitest";
import { runWithContext } from "../tenancy/context";
import { OnboardingController } from "./onboarding.controller";

/**
 * ETAPA 0 — CANDADO DE MARCA en `GET /onboarding`.
 *
 * El checklist único de montaje es de Conversia. Para TuBot (en producción) la respuesta
 * tiene que seguir siendo EXACTAMENTE la de siempre: 7 pasos, con sus claves y sus CTAs a
 * rutas de TuBot (`/channels`, `/billing`, `/agents`, `/workflows`, `/settings/users`), que
 * es lo que consume su panel (`apps/web`: "Primeros pasos" + OnboardingBanner). Si alguien
 * mueve esto, este test se pone rojo.
 */

/** Pasos y CTAs históricos de TuBot, tal cual estaban antes de la Etapa 0. */
const TUBOT_STEPS = [
  { key: "whatsapp", href: "/channels" },
  { key: "templates", href: "/onboarding/plantillas" },
  { key: "vertical", href: "/onboarding" },
  { key: "pago", href: "/billing" },
  { key: "agent", href: "/agents" },
  { key: "workflow", href: "/workflows" },
  { key: "team", href: "/settings/users" },
];

function fakePrisma(org: { brand?: string; name?: string; settings?: unknown } | null, opts: { brandThrows?: boolean } = {}) {
  const tx = {
    organization: { findUnique: async () => (org ? { settings: org.settings ?? {} } : null) },
    whatsappPhoneNumber: { count: async () => 0 },
    whatsappTemplate: { count: async () => 0 },
    agentVersion: { count: async () => 0 },
    workflowVersion: { count: async () => 0 },
    organizationUser: { count: async () => 1 },
    paymentMethod: { count: async () => 0, findFirst: async () => null },
    invoice: { count: async () => 0 },
  };
  const admin = {
    organization: {
      findUnique: async () => {
        if (opts.brandThrows) throw new Error("db down");
        return org;
      },
    },
    // Dobles para el camino Conversia (checklist único): org vacía.
    service: { count: async () => 0 },
    professional: { findMany: async () => [] },
    agentVersion: { count: async () => 0 },
    channelConnection: { count: async () => 0 },
    whatsappPhoneNumber: { count: async () => 0 },
    message: { findFirst: async () => null },
    subscription: { findFirst: async () => null },
    paymentMethod: { count: async () => 0, findFirst: async () => null },
    invoice: { count: async () => 0 },
    organizationUser: { count: async () => 1 },
    auditLog: { findFirst: async () => null },
    pushDevice: { count: async () => 0 },
  };
  return {
    admin,
    withTenant: async (_orgId: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as any;
}

const call = (prisma: any) =>
  runWithContext({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions: ["*"] }, () =>
    new OnboardingController(prisma, {} as any).status(),
  ) as Promise<any>;

describe("GET /onboarding — gate por marca", () => {
  it("TuBot: devuelve EXACTAMENTE los 7 pasos históricos, con sus CTAs de TuBot", async () => {
    const res = await call(fakePrisma({ brand: "tubot", name: "Clínica X", settings: {} }));

    expect(res.steps.map((s: any) => s.key)).toEqual(TUBOT_STEPS.map((s) => s.key));
    expect(res.steps.map((s: any) => s.cta.href)).toEqual(TUBOT_STEPS.map((s) => s.href));
    expect(res.total).toBe(7);
    expect(res.completed).toBe(0);
    expect(res.percent).toBe(0);
    expect(res.done).toBe(false);
    // La forma del paso tampoco cambia: ni campos nuevos ni campos menos.
    expect(Object.keys(res.steps[0]).sort()).toEqual(["cta", "description", "done", "key", "title"]);
    // Y el nivel superior sigue teniendo solo las 5 claves de siempre.
    expect(Object.keys(res).sort()).toEqual(["completed", "done", "percent", "steps", "total"]);
  });

  it("org sin marca explícita: se trata como TuBot", async () => {
    const res = await call(fakePrisma({ name: "Sin marca", settings: {} }));
    expect(res.steps.map((s: any) => s.key)).toEqual(TUBOT_STEPS.map((s) => s.key));
  });

  it("si no se puede leer la marca, cae a TuBot (fail-safe: nunca cambia lo que ya funciona)", async () => {
    const res = await call(fakePrisma({ brand: "conversia", name: "X", settings: {} }, { brandThrows: true }));
    expect(res.steps.map((s: any) => s.key)).toEqual(TUBOT_STEPS.map((s) => s.key));
  });

  it("Conversia: devuelve el checklist único de montaje, con href de conversia-web", async () => {
    const res = await call(fakePrisma({ brand: "conversia", name: "Barbería Centro", settings: {} }));

    expect(res.steps.map((s: any) => s.key)).toEqual([
      "negocio",
      "servicios",
      "agenda",
      "asistente",
      "whatsapp",
      "prueba",
      "pago",
      "mini_sitio",
      "equipo",
      "pwa",
      "notificaciones",
      "correo",
    ]);
    // Ningún CTA a una ruta de TuBot.
    expect(res.steps.filter((s: any) => ["/channels", "/billing", "/agents", "/workflows", "/settings/users"].includes(s.href))).toEqual([]);
    // El % cuenta solo los bloqueantes (7 con agenda) y la org vacía está en 0.
    expect(res.blockingTotal).toBe(7);
    expect(res.percent).toBe(0);
    expect(res.nextStep.key).toBe("negocio");
    // Compatibilidad: `canales/page.tsx` busca el paso por key y lee `done`.
    expect(res.steps.find((s: any) => s.key === "whatsapp")).toMatchObject({ done: false, cta: { href: "/canales" } });
  });
});
