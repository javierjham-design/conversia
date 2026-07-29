import { geoFromPhone } from "./phone-geo";

// Construcción PURA (testeable sin BD) de los datos del contacto desde el
// webhook de WhatsApp. Regla de oro: el nombre de perfil NUNCA pisa el nombre
// real; y se captura toda la atribución de anuncios (referral CTWA).

export interface ParsedContact {
  waId: string; // msg.from (wa_id, dígitos)
  profileName?: string | null; // contacts[].profile.name
  referral?: any; // objeto referral de Meta (anuncios Click-to-WhatsApp)
}

export interface ReferralFields {
  adId: string | null;
  ctwaClid: string | null;
  acquisitionSource: "ad" | "organic";
  meta: Record<string, unknown>;
}

/** Mapea el objeto referral de Meta a campos estructurados + payload crudo. */
export function referralFields(referral: any): ReferralFields {
  if (!referral || typeof referral !== "object") {
    return { adId: null, ctwaClid: null, acquisitionSource: "organic", meta: {} };
  }
  return {
    adId: referral.source_id ?? null,
    ctwaClid: referral.ctwa_clid ?? null,
    acquisitionSource: "ad",
    meta: {
      referral: {
        ctwa_clid: referral.ctwa_clid ?? null,
        source_id: referral.source_id ?? null,
        source_type: referral.source_type ?? null,
        source_url: referral.source_url ?? null,
        headline: referral.headline ?? null,
        body: referral.body ?? null,
        media_type: referral.media_type ?? null,
        image_url: referral.image_url ?? null,
        video_url: referral.video_url ?? null,
      },
    },
  };
}

/** Datos para CREAR un contacto desde el webhook (perfil separado del nombre real). */
export function buildContactCreate(parsed: ParsedContact, now: Date) {
  const geo = geoFromPhone(parsed.waId);
  const ref = referralFields(parsed.referral);
  return {
    // firstName/lastName NO se setean con el perfil — solo profileName.
    profileName: parsed.profileName ?? null,
    phone: geo.phone,
    country: geo.country,
    timezone: geo.timezone ?? undefined,
    source: "whatsapp",
    createdVia: "webhook",
    acquisitionSource: ref.acquisitionSource,
    adId: ref.adId,
    ctwaClid: ref.ctwaClid,
    meta: ref.meta as object,
    firstContactAt: now,
    lastContactAt: now,
  };
}

/**
 * Datos para ACTUALIZAR un contacto existente: refresca el nombre de perfil (si
 * cambió) y la última interacción; adjunta la atribución CTWA solo si el
 * contacto aún no la tiene y este mensaje trae referral. Nunca toca el nombre real.
 */
export function buildContactUpdate(
  existing: { profileName?: string | null; ctwaClid?: string | null; meta?: any },
  parsed: ParsedContact,
  now: Date,
): Record<string, unknown> {
  const data: Record<string, unknown> = { lastContactAt: now };
  if (parsed.profileName && parsed.profileName !== existing.profileName) data.profileName = parsed.profileName;
  if (parsed.referral && !existing.ctwaClid) {
    const ref = referralFields(parsed.referral);
    data.adId = ref.adId;
    data.ctwaClid = ref.ctwaClid;
    data.acquisitionSource = ref.acquisitionSource;
    data.meta = { ...((existing.meta as Record<string, unknown>) ?? {}), ...ref.meta };
  }
  return data;
}
