import { describe, expect, it } from "vitest";
import { getEvent, isCritical, listEvents, render } from "./catalog.js";
import { applyQuietHours, inQuietHours, isChannelEnabled, resolveEnabledChannels } from "./prefs.js";
import type { UserNotifPrefs } from "./prefs.js";

const escalation = getEvent("ai.escalation")!;
const assigned = getEvent("conversation.assigned")!;
const billing = getEvent("billing.payment_failed")!;

describe("catálogo de eventos", () => {
  it("todo evento tiene defaults ⊆ canales permitidos", () => {
    for (const e of listEvents()) {
      for (const d of e.defaultChannels) expect(e.channels).toContain(d);
      for (const l of e.lockedChannels ?? []) expect(e.channels).toContain(l);
    }
  });

  it("la escalada IA es crítica; una asignación no", () => {
    expect(isCritical("ai.escalation")).toBe(true);
    expect(isCritical("conversation.assigned")).toBe(false);
  });

  it("render rellena variables y deja vacío lo ausente", () => {
    expect(render("Hola {name}, {x}", { name: "Ana" })).toBe("Hola Ana, ");
  });
});

describe("preferencias por usuario", () => {
  it("usa defaults sin override", () => {
    expect(resolveEnabledChannels(assigned, {})).toEqual(["in_app", "web_push"]);
  });

  it("el override del usuario manda", () => {
    const prefs: UserNotifPrefs = { matrix: { [assigned.key]: { web_push: false, email: true } } };
    const ch = resolveEnabledChannels(assigned, prefs);
    expect(ch).toContain("in_app");
    expect(ch).toContain("email");
    expect(ch).not.toContain("web_push");
  });

  it("un canal bloqueado no se puede apagar (facturación al dueño)", () => {
    const prefs: UserNotifPrefs = { matrix: { [billing.key]: { email: false, in_app: false } } };
    expect(isChannelEnabled(billing, "email", prefs)).toBe(true);
    expect(isChannelEnabled(billing, "in_app", prefs)).toBe(true);
  });
});

describe("horario silencioso", () => {
  const prefs: UserNotifPrefs = { quietHours: { enabled: true, start: "22:00", end: "08:00" } };
  const tz = "America/Santiago";

  it("detecta rango que cruza medianoche", () => {
    // 02:00 UTC ≈ 22:00/23:00 en Santiago según DST → dentro del silencio.
    const at3amLocal = new Date("2026-08-09T06:00:00Z"); // 02:00/03:00 en Santiago
    expect(inQuietHours(prefs, at3amLocal, tz)).toBe(true);
  });

  it("silencia push en evento informativo, pero deja in_app/email", () => {
    const night = new Date("2026-08-09T06:00:00Z");
    const ch = applyQuietHours(["in_app", "web_push", "email"], assigned, prefs, night, tz);
    expect(ch).toContain("in_app");
    expect(ch).toContain("email");
    expect(ch).not.toContain("web_push");
  });

  it("un evento crítico ignora el horario silencioso", () => {
    const night = new Date("2026-08-09T06:00:00Z");
    const ch = applyQuietHours(["in_app", "web_push"], escalation, prefs, night, tz);
    expect(ch).toContain("web_push");
  });
});
