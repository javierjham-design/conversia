import { describe, expect, it } from "vitest";
import { geoFromPhone, toE164 } from "./phone-geo";
import { buildContactCreate, buildContactUpdate, referralFields } from "./contact-capture";

const NOW = new Date("2026-07-29T12:00:00Z");

// referral tal como lo envía Meta en un mensaje que viene de un anuncio CTWA.
const CTWA_REFERRAL = {
  source_url: "https://fb.me/xyz",
  source_id: "120210000000",
  source_type: "ad",
  headline: "Agenda tu evaluación gratis",
  body: "Toca para escribirnos",
  media_type: "image",
  image_url: "https://scontent.example/x.jpg",
  ctwa_clid: "ARBxCTWACLID123",
};

describe("phone-geo", () => {
  it("normaliza a E.164", () => {
    expect(toE164("56912345678")).toBe("+56912345678");
    expect(toE164("+56 9 1234 5678")).toBe("+56912345678");
  });
  it("infiere país por prefijo (más largo gana)", () => {
    expect(geoFromPhone("56912345678").country).toBe("CL");
    expect(geoFromPhone("51987654321").country).toBe("PE");
    expect(geoFromPhone("5215512345678").country).toBe("MX");
    expect(geoFromPhone("14155552671").country).toBe("US");
    expect(geoFromPhone("999").country).toBeNull();
    expect(geoFromPhone("56912345678").timezone).toBe("America/Santiago");
  });
});

describe("contact-capture", () => {
  it("captura el referral CTWA estructurado + payload crudo", () => {
    const r = referralFields(CTWA_REFERRAL);
    expect(r.acquisitionSource).toBe("ad");
    expect(r.adId).toBe("120210000000");
    expect(r.ctwaClid).toBe("ARBxCTWACLID123");
    expect((r.meta as any).referral.headline).toBe("Agenda tu evaluación gratis");
  });

  it("el nombre de perfil NO pisa el nombre real; guarda profileName aparte", () => {
    const c = buildContactCreate({ waId: "56912345678", profileName: "Juanito 🦷", referral: CTWA_REFERRAL }, NOW);
    expect(c.profileName).toBe("Juanito 🦷");
    expect("firstName" in c).toBe(false); // nunca setea el nombre real desde el perfil
    expect(c.phone).toBe("+56912345678");
    expect(c.country).toBe("CL");
    expect(c.acquisitionSource).toBe("ad");
    expect(c.ctwaClid).toBe("ARBxCTWACLID123");
    expect(c.createdVia).toBe("webhook");
  });

  it("contacto orgánico (sin referral)", () => {
    const c = buildContactCreate({ waId: "56912345678", profileName: "Ana" }, NOW);
    expect(c.acquisitionSource).toBe("organic");
    expect(c.adId).toBeNull();
  });

  it("update refresca perfil y adjunta atribución solo si aún no la tiene", () => {
    const withRef = buildContactUpdate({ profileName: "Ana", ctwaClid: null }, { waId: "x", profileName: "Ana 2", referral: CTWA_REFERRAL }, NOW);
    expect(withRef.profileName).toBe("Ana 2");
    expect(withRef.ctwaClid).toBe("ARBxCTWACLID123");
    const already = buildContactUpdate({ profileName: "Ana", ctwaClid: "OLD" }, { waId: "x", profileName: "Ana", referral: CTWA_REFERRAL }, NOW);
    expect("ctwaClid" in already).toBe(false); // no sobreescribe atribución existente
    expect(already.profileName).toBeUndefined(); // no cambió el perfil
  });
});
