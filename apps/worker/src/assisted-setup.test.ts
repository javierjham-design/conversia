import { describe, expect, it, vi } from "vitest";
import { AssistedSetupDenied, openAssistedSetup, type AssistedSetupDeps, type AssistedGrant } from "./assisted-setup";

const CLIENT = "org_cliente";
const TUBOT = "org_tubot";
const OTRO = "org_otro_proveedor";

/** tx falso que registra las tablas tocadas (para verificar el LÍMITE). */
function fakeTx() {
  const touched: string[] = [];
  const rec = (table: string) => touched.push(table);
  return {
    touched,
    tx: {
      agent: {
        findFirst: async () => { rec("agent.read"); return null; },
        create: async () => { rec("agent.write"); return { id: "a1" }; },
        update: async () => { rec("agent.write"); return { id: "a1" }; },
        count: async () => { rec("agent.read"); return 0; },
      },
      agentVersion: {
        findFirst: async () => null,
        create: async () => { rec("agentVersion.write"); return { id: "v1" }; },
      },
      workflow: { count: async () => 0 },
      service: { count: async () => 0 },
      knowledgeDocument: { count: async () => 0 },
      auditLog: { create: async (args: any) => { rec("auditLog.write"); return args; } },
    } as any,
  };
}

/** deps con un grant configurable; captura los audit_log escritos. */
function makeDeps(grant: AssistedGrant | null, opts: { now?: Date } = {}): {
  deps: AssistedSetupDeps;
  audits: any[];
  touched: string[];
} {
  const audits: any[] = [];
  const touchedAll: string[] = [];
  const deps: AssistedSetupDeps = {
    findActiveGrant: vi.fn(async (clientOrgId, providerOrgId) => {
      // Simula la RLS/where: solo devuelve el grant si coincide cliente+proveedor.
      if (!grant) return null;
      if (clientOrgId !== CLIENT || providerOrgId !== TUBOT) return null;
      return grant;
    }),
    runInTenant: async (_clientOrgId, fn) => {
      const { tx, touched } = fakeTx();
      // envuelve auditLog.create para capturar
      const origAudit = tx.auditLog.create;
      tx.auditLog.create = async (args: any) => { audits.push(args.data); return origAudit(args); };
      const r = await fn(tx);
      touchedAll.push(...touched);
      return r;
    },
    now: () => opts.now ?? new Date("2026-08-17T12:00:00Z"),
  };
  return { deps, audits, touched: touchedAll };
}

const activeGrant = (): AssistedGrant => ({ id: "g1", scopes: ["agents", "flows", "services", "knowledge"], expiresAt: new Date("2026-08-31T12:00:00Z") });

describe("montaje asistido — el límite de seguridad cross-tenant", () => {
  it("SIN autorización → niega todo", async () => {
    const { deps } = makeDeps(null);
    await expect(openAssistedSetup(CLIENT, TUBOT, deps)).rejects.toBeInstanceOf(AssistedSetupDenied);
  });

  it("autorización EXPIRADA → niega", async () => {
    const expired: AssistedGrant = { ...activeGrant(), expiresAt: new Date("2026-08-01T00:00:00Z") };
    const { deps } = makeDeps(expired, { now: new Date("2026-08-17T12:00:00Z") });
    await expect(openAssistedSetup(CLIENT, TUBOT, deps)).rejects.toBeInstanceOf(AssistedSetupDenied);
  });

  it("REVOCADA (findActiveGrant devuelve null) → corta el acceso al instante", async () => {
    const { deps } = makeDeps(null); // revocado = ya no está activo
    await expect(openAssistedSetup(CLIENT, TUBOT, deps)).rejects.toBeInstanceOf(AssistedSetupDenied);
  });

  it("OTRO proveedor (no TuBot) → no puede usar la capacidad", async () => {
    const { deps } = makeDeps(activeGrant());
    // el grant es para TUBOT; otro proveedor no lo encuentra
    await expect(openAssistedSetup(CLIENT, OTRO, deps)).rejects.toBeInstanceOf(AssistedSetupDenied);
  });

  it("el proveedor no puede montarse a sí mismo", async () => {
    const { deps } = makeDeps(activeGrant());
    await expect(openAssistedSetup(TUBOT, TUBOT, deps)).rejects.toBeInstanceOf(AssistedSetupDenied);
  });

  it("CON autorización → puede escribir CONFIG (agente) y NO expone conversaciones/contactos", async () => {
    const { deps, audits, touched } = makeDeps(activeGrant());
    const svc = await openAssistedSetup(CLIENT, TUBOT, deps);

    // El servicio SOLO tiene operaciones de configuración — garantía estructural.
    const methods = Object.keys(svc);
    expect(methods).toEqual(expect.arrayContaining(["getSetupState", "upsertClientAgent"]));
    expect(methods).not.toContain("getConversations");
    expect(methods).not.toContain("getContacts");
    expect(methods).not.toContain("sendMessage");

    const r = await svc.upsertClientAgent({ slug: "recepcionista", name: "Recepcionista", systemPrompt: "Eres…", tools: ["searchKnowledgeBase"] });
    expect(r.agentId).toBeTruthy();
    // Tocó solo tablas de configuración (agent/agentVersion) + auditoría; nada de conversaciones/contactos.
    expect(touched.every((t) => /^(agent|agentVersion|auditLog)\./.test(t))).toBe(true);
    // La acción quedó auditada como montaje asistido en el tenant del cliente.
    expect(audits.some((a) => a.actorType === "assisted_setup" && a.actorId === TUBOT && a.organizationId === CLIENT)).toBe(true);
  });

  it("scope NO incluido → niega esa operación", async () => {
    const grantSoloKB: AssistedGrant = { ...activeGrant(), scopes: ["knowledge"] };
    const { deps } = makeDeps(grantSoloKB);
    const svc = await openAssistedSetup(CLIENT, TUBOT, deps);
    await expect(svc.upsertClientAgent({ slug: "x", name: "X", systemPrompt: "…" })).rejects.toBeInstanceOf(AssistedSetupDenied);
  });
});
