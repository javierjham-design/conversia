import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { runWithContext, type RequestContext } from "../tenancy/context";
import { ChargingController } from "./charging.controller";

/**
 * §3.1 — Cambiar la cuenta de cobro (Flow/Getnet) o enviar un link de pago mueve dinero: un usuario
 * "Solo lectura" NO debe poder redirigir los cobros del negocio. Antes ambos endpoints usaban solo
 * requireContext() (cualquier sesión). Ahora save() exige settings:write y createLink() inbox:write.
 */
function fakePrisma() {
  const auditCreate = vi.fn().mockResolvedValue({});
  const orgUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    admin: {
      organization: { findUnique: vi.fn().mockResolvedValue({ settings: {} }), update: orgUpdate },
      integrationCredential: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: auditCreate },
    },
  };
  return { prisma, auditCreate, orgUpdate };
}

const ctx = (permissions: string[]): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "viewer", permissions });

describe("ChargingController — permisos (§3.1)", () => {
  it("save() rechaza a un 'Solo lectura' (sin settings:write)", async () => {
    const { prisma } = fakePrisma();
    const c = new ChargingController(prisma as never);
    await expect(
      runWithContext(ctx(["inbox:write"]), () => c.save({ provider: "flow", apiKey: "k", secretKey: "s" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("save() permite con settings:write y AUDITA el cambio de credenciales (sin valores)", async () => {
    const { prisma, auditCreate } = fakePrisma();
    const c = new ChargingController(prisma as never);
    const r = await runWithContext(ctx(["settings:write"]), () => c.save({ provider: "flow", apiKey: "k", secretKey: "s" }));
    expect(r).toEqual({ ok: true });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.action).toBe("charging.credentials_updated");
    // Nunca se registran los valores de las credenciales.
    expect(JSON.stringify(data)).not.toContain("secretKey");
  });

  it("createLink() exige inbox:write", async () => {
    const { prisma } = fakePrisma();
    const c = new ChargingController(prisma as never);
    await expect(
      runWithContext(ctx([]), () => c.createLink({ amount: 1000, concept: "Consulta" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
