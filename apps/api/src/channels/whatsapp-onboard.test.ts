import { describe, expect, it, vi } from "vitest";
import { subscribeAndRegisterWhatsapp } from "./whatsapp-onboard";

const okRes = (body: unknown = { success: true }) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errRes = (status: number, error: unknown) => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response;

describe("subscribeAndRegisterWhatsapp — la conexión manual engancha el número a Meta", () => {
  it("suscribe + registra OK → sin avisos y en el orden correcto", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okRes()).mockResolvedValueOnce(okRes());
    const warnings = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);

    expect(warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/WABA1/subscribed_apps");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/PHONE1/register");
    // el register manda messaging_product + pin
    const registerBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(registerBody.messaging_product).toBe("whatsapp");
    expect(String(registerBody.pin)).toMatch(/^\d{6}$/);
  });

  it("register falla con #133010 → avisa que hay que registrar para ENVIAR", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce(errRes(400, { code: 133010, message: "Account is not registered" }));
    const warnings = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.some((w) => /registrar/i.test(w) && /133010/.test(w))).toBe(true);
  });

  it("número YA registrado → NO se trata como error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce(errRes(400, { message: "Phone number already registered" }));
    const warnings = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings).toEqual([]);
  });

  it("subscribed_apps falla → avisa de mensajes entrantes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(400, { message: "no access to waba" }))
      .mockResolvedValueOnce(okRes());
    const warnings = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.some((w) => /entrantes/i.test(w))).toBe(true);
  });

  it("no lanza aunque fetch reviente; devuelve avisos", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const warnings = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => /network down/.test(w))).toBe(true);
  });
});
