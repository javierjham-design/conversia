import { describe, expect, it } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PlatformController } from "../src/platform/platform.controller";
import type { PlatformRequest } from "../src/platform/platform.guard";

/**
 * §6.3 / §6.5 — Aislamiento POR MARCA en /platform.
 *
 * `/platform` lo comparten los super admins de TuBot y de Conversia. Varias acciones iban
 * por `id` suelto: quien tuviera (o adivinara) el id de una fila de la otra marca podía
 * editarle el precio a un plan, borrarle un paquete, cerrarle un ticket a un cliente ajeno
 * o dar por pagada una factura impaga. Acá se prueba que ya no.
 *
 * El criterio de respuesta es 404, no 403: un 403 confirmaría que ese id existe en la otra
 * marca.
 */

type Fila = { id: string; brand?: string; organizationId?: string | null };

function makeCtl(datos: {
  plan?: Fila | null;
  paquete?: Fila | null;
  factura?: Fila | null;
  ticket?: Fila | null;
  lead?: Fila | null;
  org?: { brand: string } | null;
}) {
  const creados: Record<string, unknown>[] = [];
  const actualizados: Record<string, unknown>[] = [];
  const borrados: string[] = [];
  const consultas: Record<string, unknown>[] = [];

  /** Simula `findFirst({ where: { id, brand } })`: devuelve la fila solo si la marca calza. */
  const porMarca = (fila: Fila | null | undefined) => async (args: any) => {
    consultas.push(args?.where ?? {});
    if (!fila) return null;
    if (args?.where?.brand && fila.brand !== args.where.brand) return null;
    if (args?.where?.id && fila.id !== args.where.id) return null;
    return fila;
  };

  const admin: any = {
    plan: {
      findMany: async (args: any) => {
        consultas.push(args?.where ?? {});
        return [];
      },
      findFirst: porMarca(datos.plan),
      create: async ({ data }: any) => {
        creados.push(data);
        return { id: "plan_nuevo", ...data };
      },
      update: async ({ data }: any) => {
        actualizados.push(data);
        return { id: datos.plan?.id ?? "plan_1", ...data };
      },
    },
    messagePackage: {
      findFirst: porMarca(datos.paquete),
      update: async ({ data }: any) => {
        actualizados.push(data);
        return { id: "pkg_1", ...data };
      },
      delete: async ({ where }: any) => {
        borrados.push(where.id);
        return { id: where.id };
      },
    },
    invoice: {
      findUnique: async () => datos.factura ?? null,
      update: async ({ data }: any) => {
        actualizados.push(data);
        return { id: "inv_1", status: "PAID", ...data };
      },
    },
    supportTicket: {
      findUnique: async () => datos.ticket ?? null,
      update: async ({ data }: any) => {
        actualizados.push(data);
        return { id: "t_1", status: data.status };
      },
    },
    demoLead: {
      findUnique: async () => datos.lead ?? null,
      update: async ({ data }: any) => {
        actualizados.push(data);
        return { id: "lead_1", ...data };
      },
      create: async ({ data }: any) => {
        creados.push(data);
        return { id: "lead_nuevo", ...data };
      },
    },
    organization: { findUnique: async () => datos.org ?? null },
    auditLog: { create: async () => ({}) },
    platformSetting: { findUnique: async () => null, upsert: async () => ({}) },
  };

  const prisma: any = { admin, withTenant: (_o: string, fn: any) => fn(admin) };
  const ctl = new PlatformController(prisma, {} as any, {} as any, {} as any, {} as any);
  return { ctl, creados, actualizados, borrados, consultas };
}

const req = (brand: string): PlatformRequest =>
  ({ platformAdmin: { sub: "sa_1", brand, role: "owner" } }) as unknown as PlatformRequest;

describe("§6.3 — planes por marca", () => {
  it("el listado se filtra por la marca del admin", async () => {
    const { ctl, consultas } = makeCtl({});
    await ctl.plans(req("conversia"));
    expect(consultas[0]).toEqual({ brand: "conversia" });
  });

  it("un plan nuevo NACE en la marca del admin (no en la del cuerpo)", async () => {
    const { ctl, creados } = makeCtl({});
    await ctl.createPlan({ code: "nuevo", name: "Plan Nuevo", brand: "tubot" }, req("conversia"));
    expect((creados[0] as any).brand).toBe("conversia");
  });

  it("editar un plan de OTRA marca → 404 y no escribe nada", async () => {
    const { ctl, actualizados } = makeCtl({ plan: { id: "plan_1", brand: "tubot" } });
    await expect(ctl.updatePlan("plan_1", { priceClp: 1 }, req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(actualizados).toEqual([]);
  });

  it("editar un plan de SU marca sí funciona", async () => {
    const { ctl, actualizados } = makeCtl({ plan: { id: "plan_1", brand: "conversia" } });
    await ctl.updatePlan("plan_1", { priceClp: 1234 }, req("conversia"));
    expect(actualizados.length).toBe(1);
  });
});

describe("§6.5 — mutaciones por id que cruzaban marcas", () => {
  it("editar un paquete de otra marca → 404", async () => {
    const { ctl, actualizados } = makeCtl({ paquete: { id: "pkg_1", brand: "tubot" } });
    await expect(ctl.updatePackage("pkg_1", { priceClp: 1 }, req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(actualizados).toEqual([]);
  });

  it("borrar un paquete de otra marca → 404 y NO lo borra", async () => {
    const { ctl, borrados } = makeCtl({ paquete: { id: "pkg_1", brand: "tubot" } });
    await expect(ctl.deletePackage("pkg_1", req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(borrados).toEqual([]);
  });

  it("borrar un paquete de SU marca sí lo borra", async () => {
    const { ctl, borrados } = makeCtl({ paquete: { id: "pkg_1", brand: "conversia" } });
    await ctl.deletePackage("pkg_1", req("conversia"));
    expect(borrados).toEqual(["pkg_1"]);
  });

  it("dar por pagada una factura de un cliente de otra marca → 404 (es dinero)", async () => {
    const { ctl, actualizados } = makeCtl({ factura: { id: "inv_1", organizationId: "org_tb" }, org: { brand: "tubot" } });
    await expect(ctl.markPaid("inv_1", req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(actualizados).toEqual([]);
  });

  it("dar por pagada una factura de SU marca sí funciona", async () => {
    const { ctl, actualizados } = makeCtl({ factura: { id: "inv_1", organizationId: "org_cv" }, org: { brand: "conversia" } });
    await ctl.markPaid("inv_1", req("conversia"));
    expect(actualizados.length).toBe(1);
  });

  it("cerrar un ticket de un cliente de otra marca → 404 (el cliente lo ve en su widget)", async () => {
    const { ctl, actualizados } = makeCtl({ ticket: { id: "t_1", organizationId: "org_tb" }, org: { brand: "tubot" } });
    await expect(ctl.updateSupport("t_1", { status: "resolved" }, req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(actualizados).toEqual([]);
  });

  it("un prospecto SIN organización no lo alcanza otra marca (regla D8)", async () => {
    const { ctl, actualizados } = makeCtl({ lead: { id: "lead_1", organizationId: null } });
    await expect(ctl.updateDemoLead("lead_1", { status: "WON" }, req("conversia"))).rejects.toBeInstanceOf(NotFoundException);
    expect(actualizados).toEqual([]);
  });

  it("TuBot sí alcanza los prospectos sin organización (su CRM público, sin cambios)", async () => {
    const { ctl, actualizados } = makeCtl({ lead: { id: "lead_1", organizationId: null } });
    await ctl.updateDemoLead("lead_1", { status: "WON" }, req("tubot"));
    expect(actualizados.length).toBe(1);
  });
});

describe("§6.5 — la configuración GLOBAL solo la administra TuBot", () => {
  const globales: Array<[string, (c: PlatformController, r: PlatformRequest) => unknown]> = [
    ["precio de activación de plantillas", (c, r) => c.setTemplatesPricing({ priceClp: 1 }, r)],
    ["tarifas de Meta y tipo de cambio", (c, r) => c.updateCostSettings({ usdToClp: 1 }, r)],
    ["topes globales de mensajería", (c, r) => c.setMessagingLimits({ global: 10 }, r)],
    ["probar las llaves de IA", (c, r) => c.testAi({ model: "x" }, r)],
    ["crear un cupón", (c, r) => c.createCoupon({ code: "ABC", discountType: "PERCENT", discountValue: 10 }, r)],
    ["editar un cupón", (c, r) => c.updateCoupon("c_1", { active: false }, r)],
    ["borrar un cupón", (c, r) => c.deleteCoupon("c_1", r)],
    ["crear un prospecto", (c, r) => c.createDemoLead({ name: "Ana", email: "a@x.cl" }, r)],
  ];

  for (const [nombre, accion] of globales) {
    it(`${nombre}: un admin de Conversia → 403`, async () => {
      const { ctl } = makeCtl({});
      await expect(Promise.resolve().then(() => accion(ctl, req("conversia")))).rejects.toBeInstanceOf(ForbiddenException);
    });
  }
});
