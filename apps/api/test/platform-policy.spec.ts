import { describe, expect, it } from "vitest";
import { isFullPlatformAdmin, operatorMayAccess, OPERATOR_DENY_PREFIXES } from "../src/platform/platform-policy";

// F10 — el rol OPERADOR opera la ficha de clientes pero NO la configuración global de
// la plataforma. Estos tests fijan "lo prohibido, prohibido de verdad".

describe("F10 — roles de plataforma", () => {
  it("owner y admin son super admin (acceso total)", () => {
    expect(isFullPlatformAdmin("owner")).toBe(true);
    expect(isFullPlatformAdmin("admin")).toBe(true);
    expect(isFullPlatformAdmin("OWNER")).toBe(true); // case-insensitive
  });
  it("operador (y cualquier otro) NO es super admin", () => {
    expect(isFullPlatformAdmin("operador")).toBe(false);
    expect(isFullPlatformAdmin("support")).toBe(false);
    expect(isFullPlatformAdmin("")).toBe(false);
    expect(isFullPlatformAdmin(undefined)).toBe(false);
  });
});

describe("F10 — operatorMayAccess: rutas GLOBALES prohibidas al operador", () => {
  const forbidden = [
    "/platform/plans",
    "/platform/plans/abc",
    "/platform/packages",
    "/platform/coupons/xyz",
    "/platform/cost-settings",
    "/platform/cost-model",
    "/platform/templates-pricing",
    "/platform/messaging-limits",
    "/platform/wallet-weights",
    "/platform/billing/providers",
    "/platform/billing/settings",
    "/platform/billing/flow/test",
    "/platform/billing/recurring",
    "/platform/invoices",
    "/platform/invoices/inv_1/mark-paid",
    "/platform/margins",
    "/platform/infra",
    "/platform/test-ai",
    "/platform/audit",
    "/platform/admins",
    "/platform/admins/op_1",
    "/platform/metrics",
    "/platform/quality",
  ];
  for (const path of forbidden) {
    it(`deniega ${path}`, () => expect(operatorMayAccess(path)).toBe(false));
  }
  it("deniega aunque venga con querystring o barra final", () => {
    expect(operatorMayAccess("/platform/plans?x=1")).toBe(false);
    expect(operatorMayAccess("/platform/billing/")).toBe(false);
  });
});

describe("F10 — operatorMayAccess: operar la FICHA del cliente sí se permite", () => {
  const allowed = [
    "/platform/organizations",
    "/platform/organizations/org_1",
    "/platform/organizations/org_1/config",
    "/platform/organizations/org_1/status",
    "/platform/organizations/org_1/subscription", // billing POR-ORG (operar al cliente)
    "/platform/organizations/org_1/billing-action",
    "/platform/organizations/org_1/payment-link",
    "/platform/organizations/org_1/invoices", // crear factura per-org
    "/platform/organizations/org_1/wallet-adjust",
    "/platform/organizations/org_1/agents/ag_1/prompt",
    "/platform/organizations/org_1/channels",
    "/platform/organizations/org_1/onboarding",
    "/platform/organizations/org_1/impersonate",
    "/platform/organizations/org_1/implementation",
    "/platform/organizations/org_1/client-context",
    "/platform/organizations/org_1/lifecycle/delivered",
    "/platform/organizations/org_1/cash-summary",
    "/platform/organizations/org_1/agents", // R2 — configurador de agentes (operar la ficha)
    "/platform/organizations/org_1/agents/meta/tools",
    "/platform/organizations/org_1/agents/ag_1",
    "/platform/organizations/org_1/agents/ag_1/draft",
    "/platform/organizations/org_1/agents/ag_1/publish",
    "/platform/organizations/org_1/agents/ag_1/test",
    "/platform/organizations/org_1/channels/ch_1/default-agent",
    "/platform/alerts",
    "/platform/support",
    "/platform/support/t_1/reply",
    "/platform/demo-leads",
    "/platform/verticals",
    "/platform/auth/login",
    "/platform/auth/mfa/enroll",
  ];
  for (const path of allowed) {
    it(`permite ${path}`, () => expect(operatorMayAccess(path)).toBe(true));
  }
  it("billing POR-ORG no colisiona con la denylist global de /platform/billing", () => {
    expect(operatorMayAccess("/platform/organizations/o/billing-action")).toBe(true);
    expect(operatorMayAccess("/platform/organizations/o/billing-diagnose")).toBe(true);
    expect(operatorMayAccess("/platform/billing/settings")).toBe(false);
  });
});

describe("F10 — invariante: cada prefijo de la denylist queda efectivamente bloqueado", () => {
  for (const pre of OPERATOR_DENY_PREFIXES) {
    it(`bloquea exactamente ${pre} y sus sub-rutas`, () => {
      expect(operatorMayAccess(pre)).toBe(false);
      expect(operatorMayAccess(pre + "/algo")).toBe(false);
    });
  }
});
