import { describe, expect, it } from "vitest";
import { parseSignedRequest } from "./signed-request";

// signed_request de Meta = <firma_base64url>.<payload_base64url>, firma =
// HMAC-SHA256(payload, app_secret). Solo confiamos en el payload si la firma
// verifica; si no, null. Fixture generado con node crypto (secret abajo).
describe("parseSignedRequest (Meta)", () => {
  const secret = "test-app-secret";
  const valid =
    "vjP-rj9NBRFDA8V4DUs0TAsl6Xhbuv0dU-kIPG5NxYs.eyJhbGdvcml0aG0iOiJITUFDLVNIQTI1NiIsImlzc3VlZF9hdCI6MTc4NTQ0NzY0MSwidXNlcl9pZCI6IjEyMzQ1Njc4OTAifQ";

  it("decodifica el payload con firma válida", () => {
    const data = parseSignedRequest(valid, secret);
    expect(data).not.toBeNull();
    expect(data?.user_id).toBe("1234567890");
    expect(data?.algorithm).toBe("HMAC-SHA256");
  });

  it("rechaza firma inválida (secret equivocado)", () => {
    expect(parseSignedRequest(valid, "otro-secret")).toBeNull();
  });

  it("rechaza payload manipulado (firma no coincide)", () => {
    const [sig] = valid.split(".");
    const tampered = `${sig}.eyJ1c2VyX2lkIjoiOTk5OTk5In0`; // {"user_id":"999999"}
    expect(parseSignedRequest(tampered, secret)).toBeNull();
  });

  it("rechaza entradas mal formadas o vacías", () => {
    expect(parseSignedRequest("", secret)).toBeNull();
    expect(parseSignedRequest("sinpunto", secret)).toBeNull();
    expect(parseSignedRequest(valid, "")).toBeNull();
  });
});
