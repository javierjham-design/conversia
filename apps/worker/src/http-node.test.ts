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

/** Respuesta fetch mínima simulada. */
function fakeRes(status: number, bodyText: string) {
  return { status, ok: status >= 200 && status < 300, text: async () => bodyText } as unknown as Response;
}

describe("Petición HTTP — éxito, 4xx, 5xx, timeout, mapeo de variables", () => {
  const URL_OK = "http://93.184.216.34/api"; // IP pública → pasa el guard SSRF sin DNS
  function withFetch(fn: (u: string, opts: any) => Promise<Response> | Promise<never>) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, opts: any) => fn(String(u), opts)) as unknown as typeof fetch;
    return () => { globalThis.fetch = orig; };
  }

  it("200 con éxito: __http_ok=true, __http_status=200 y mapea la respuesta JSON a variables", async () => {
    const restore = withFetch(async () => fakeRes(200, JSON.stringify({ data: { token: "abc123", nested: { n: 7 } } })));
    try {
      const out = await callHttp({ method: "GET", url: URL_OK, responseMapping: { miToken: "data.token", num: "data.nested.n" } }, {});
      expect(out.__http_ok).toBe("true");
      expect(out.__http_status).toBe("200");
      expect(out.miToken).toBe("abc123");
      expect(out.num).toBe("7");
    } finally { restore(); }
  });

  it("4xx: __http_ok=false y __http_status=404, sin lanzar (permite ramificar)", async () => {
    const restore = withFetch(async () => fakeRes(404, "not found"));
    try {
      const out = await callHttp({ method: "POST", url: URL_OK, body: '{"x":1}' }, {});
      expect(out.__http_ok).toBe("false");
      expect(out.__http_status).toBe("404");
      expect(out.__http_error).toBeUndefined();
    } finally { restore(); }
  });

  it("5xx: __http_ok=false y __http_status=500", async () => {
    const restore = withFetch(async () => fakeRes(500, "boom"));
    try {
      const out = await callHttp({ method: "GET", url: URL_OK }, {});
      expect(out.__http_ok).toBe("false");
      expect(out.__http_status).toBe("500");
    } finally { restore(); }
  });

  it("timeout / error de red: __http_ok=false y __http_error, sin lanzar", async () => {
    const restore = withFetch(async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); });
    try {
      const out = await callHttp({ method: "GET", url: URL_OK, timeoutMs: 50 }, {});
      expect(out.__http_ok).toBe("false");
      expect(out.__http_error).toMatch(/abort/i);
    } finally { restore(); }
  });

  it("renderiza variables en url, headers y body antes de llamar", async () => {
    let seen: any = null;
    const restore = withFetch(async (u, opts) => { seen = { u, opts }; return fakeRes(200, "{}"); });
    try {
      await callHttp(
        { method: "POST", url: "http://93.184.216.34/u/{{contact.id}}", headers: { "X-Tok": "{{tok}}" }, body: '{"n":"{{contact.firstName}}"}' },
        { "contact.id": "42", tok: "secreto", "contact.firstName": "Ana" },
      );
      expect(seen.u).toBe("http://93.184.216.34/u/42");
      expect(seen.opts.headers["X-Tok"]).toBe("secreto");
      expect(seen.opts.body).toBe('{"n":"Ana"}');
    } finally { restore(); }
  });
});
