import { describe, expect, it } from "vitest";
import { assertSafeUrl, callHttp, isBlockedIp } from "./http-node";

describe("guard SSRF de la Petición HTTP", () => {
  it("isBlockedIp bloquea rangos internos y metadata", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.0.0.5", "192.168.1.1", "172.16.5.5", "172.31.0.1", "169.254.169.254", "::1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  it("rechaza esquemas no http/https", async () => {
    await expect(assertSafeUrl("ftp://example.com/x")).rejects.toThrow(/http/i);
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
    await expect(assertSafeUrl("no-es-url")).rejects.toThrow(/inválida/i);
  });

  it("rechaza localhost y IPs internas (incluida la metadata de nube)", async () => {
    await expect(assertSafeUrl("http://localhost:8080/")).rejects.toThrow(/localhost/i);
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/interna/i);
    await expect(assertSafeUrl("http://10.0.0.5/admin")).rejects.toThrow(/interna/i);
    await expect(assertSafeUrl("http://192.168.0.1/")).rejects.toThrow(/interna/i);
  });

  it("respeta la allowlist del tenant", async () => {
    await expect(assertSafeUrl("http://evil.com/x", ["api.miempresa.cl"])).rejects.toThrow(/no permitido/i);
  });

  it("no sigue redirecciones (SSRF por redirect): pasa redirect:'error' y reporta no-ok si el redirect se bloquea", async () => {
    const orig = globalThis.fetch;
    let seen: any = null;
    // Mock: captura las opciones y simula el bloqueo de redirect (redirect:"error" hace throw en runtime real).
    globalThis.fetch = (async (_u: unknown, opts: any) => {
      seen = opts;
      throw new TypeError("net::ERR_FAILED redirect");
    }) as unknown as typeof fetch;
    try {
      // IP pública (pasa el guard SSRF); el "redirect" bloqueado se refleja como no-ok, sin lanzar.
      const out = await callHttp({ method: "GET", url: "http://93.184.216.34/x" }, {});
      expect(out.__http_ok).toBe("false");
      expect(out.__http_error).toBeTruthy();
    } finally {
      globalThis.fetch = orig;
    }
    expect(seen?.redirect).toBe("error");
  });
});
