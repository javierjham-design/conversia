import { describe, expect, it, vi } from "vitest";
import { subscribeAndRegisterWhatsapp } from "./whatsapp-onboard";

const okRes = (body: unknown = { success: true }) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errRes = (status: number, error: unknown) => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response;

describe("subscribeAndRegisterWhatsapp — la conexión manual engancha el número a Meta", () => {
  it("suscribe + registra OK → sin avisos, ambos pasos ok y en el orden correcto", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(okRes()).mockResolvedValueOnce(okRes());
    const { warnings, steps } = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);

    expect(warnings).toEqual([]);
    expect(steps.map((s) => [s.step, s.ok])).toEqual([["subscribe", true], ["register", true]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/WABA1/subscribed_apps");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/PHONE1/register");
    // el register manda messaging_product + pin
    const registerBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(registerBody.messaging_product).toBe("whatsapp");
    expect(String(registerBody.pin)).toMatch(/^\d{6}$/);
  });

  it("register falla con #133010 → avisa y marca el paso register como fallido", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce(errRes(400, { code: 133010, message: "Account is not registered" }));
    const { warnings, steps } = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.some((w) => /registrar/i.test(w))).toBe(true);
    expect(steps.find((s) => s.step === "register")?.ok).toBe(false);
  });

  it("número YA registrado → NO se trata como error (paso register ok)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce(errRes(400, { message: "Phone number already registered" }));
    const { warnings, steps } = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings).toEqual([]);
    expect(steps.find((s) => s.step === "register")?.ok).toBe(true);
  });

  it("subscribed_apps falla → avisa de mensajes entrantes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errRes(400, { message: "no access to waba" }))
      .mockResolvedValueOnce(okRes());
    const { warnings, steps } = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.some((w) => /entrantes/i.test(w))).toBe(true);
    expect(steps.find((s) => s.step === "subscribe")?.ok).toBe(false);
  });

  it("no lanza aunque fetch reviente; devuelve avisos en ambos pasos", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const { warnings, steps } = await subscribeAndRegisterWhatsapp("WABA1", "PHONE1", "TOKEN", fetchMock as unknown as typeof fetch);
    expect(warnings.length).toBe(2);
    expect(warnings.every((w) => /network down/.test(w))).toBe(true);
    expect(steps.every((s) => !s.ok)).toBe(true);
  });
});
