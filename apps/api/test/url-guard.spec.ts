import { describe, expect, it } from "vitest";
import { validateOutboundUrl } from "../src/common/url-guard";

describe("validateOutboundUrl (SSRF)", () => {
  it("acepta https públicas", () => {
    expect(validateOutboundUrl("https://api.ejemplo.cl/webhook").ok).toBe(true);
  });
  it("rechaza http no-localhost", () => {
    expect(validateOutboundUrl("http://api.ejemplo.cl/x").ok).toBe(false);
  });
  it("permite localhost solo con flag de desarrollo", () => {
    expect(validateOutboundUrl("http://localhost:4010/x").ok).toBe(false);
    expect(validateOutboundUrl("http://localhost:4010/x", { allowLocalhost: true }).ok).toBe(true);
  });
  it("rechaza IPs privadas y loopback", () => {
    for (const bad of [
      "https://10.0.0.5/h",
      "https://192.168.1.10/h",
      "https://172.16.0.1/h",
      "https://127.0.0.1/h",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(validateOutboundUrl(bad).ok).toBe(false);
    }
  });
  it("rechaza hosts internos y esquemas raros", () => {
    expect(validateOutboundUrl("https://postgres.railway.internal/h").ok).toBe(false);
    expect(validateOutboundUrl("https://mi-servicio.local/h").ok).toBe(false);
    expect(validateOutboundUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateOutboundUrl("https://user:pass@ejemplo.cl/h").ok).toBe(false);
  });
});
