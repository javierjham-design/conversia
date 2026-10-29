import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PublicController } from "../src/public/public.controller";

/**
 * AJUSTE FINAL §3.7 — el hash de IP del generador público (/crear, antiabuso 3 drafts/hora)
 * debe salir de `req.ip` (que Express deriva con `trust proxy` y NO se puede falsificar), no
 * del primer valor de X-Forwarded-For leído a mano, que el cliente podía mandar a su antojo
 * para saltarse el límite por IP.
 */

function makeReq(ip: string | undefined, xff?: string) {
  return {
    ip,
    headers: xff ? { "x-forwarded-for": xff } : {},
    socket: { remoteAddress: "10.0.0.1" },
  } as any;
}

describe("PublicController.ipHash", () => {
  const c = new PublicController({} as any, {} as any);
  const hashOf = (req: any) => (c as any).ipHash(req) as string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

  it("usa req.ip e IGNORA un X-Forwarded-For falsificado", () => {
    expect(hashOf(makeReq("1.2.3.4", "9.9.9.9, 8.8.8.8"))).toBe(sha("1.2.3.4"));
  });

  it("con el mismo req.ip, cambiar la cabecera ya no cambia el hash", () => {
    expect(hashOf(makeReq("1.2.3.4", "9.9.9.9"))).toBe(hashOf(makeReq("1.2.3.4", "7.7.7.7")));
  });

  it("sin req.ip cae a socket.remoteAddress", () => {
    expect(hashOf(makeReq(undefined))).toBe(sha("10.0.0.1"));
  });
});
