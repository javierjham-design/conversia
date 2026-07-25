import { describe, expect, it } from "vitest";
import { hasPermission } from "@conversia/types";

describe("hasPermission", () => {
  it("wildcard total", () => {
    expect(hasPermission(["*"], "inbox:write")).toBe(true);
  });
  it("permiso exacto", () => {
    expect(hasPermission(["inbox:read"], "inbox:read")).toBe(true);
    expect(hasPermission(["inbox:read"], "inbox:write")).toBe(false);
  });
  it("wildcard por módulo", () => {
    expect(hasPermission(["inbox:*"], "inbox:write")).toBe(true);
    expect(hasPermission(["inbox:*"], "contacts:read")).toBe(false);
  });
});
