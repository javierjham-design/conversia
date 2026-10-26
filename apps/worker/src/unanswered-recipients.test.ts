import { describe, expect, it } from "vitest";
import { getEvent } from "@conversia/notifications";
import { resolveRecipients } from "./notifications/dispatch";

/**
 * §8.5 — reliability-monitor levanta `conversation.unanswered` para conversaciones SIN asignar.
 * Como su audiencia era ["assigned_user","team"], resolveRecipients devolvía [] y la alerta no le
 * llegaba a nadie. Con "tenant_admins" en la audiencia, una conversación sin asignar notifica a los
 * admins/owner del tenant.
 */
function fakePrisma(members: { userId: string; roleId: string }[], roles: { id: string; code: string }[]) {
  return {
    teamMember: { findMany: async () => [] },
    organizationUser: { findMany: async () => members },
    role: { findMany: async () => roles },
  } as never;
}

describe("resolveRecipients — conversación sin asignar (§8.5)", () => {
  const event = getEvent("conversation.unanswered")!;
  const prisma = fakePrisma(
    [
      { userId: "owner1", roleId: "r_owner" },
      { userId: "admin1", roleId: "r_admin" },
      { userId: "viewer1", roleId: "r_viewer" },
    ],
    [
      { id: "r_owner", code: "owner" },
      { id: "r_admin", code: "admin" },
    ],
  );

  it("sin assigned_user ni team devuelve a los admins/owner del tenant", async () => {
    const ids = await resolveRecipients(prisma, "org1", event, {});
    expect(ids).toEqual(expect.arrayContaining(["owner1", "admin1"]));
    expect(ids).not.toContain("viewer1");
  });
});
