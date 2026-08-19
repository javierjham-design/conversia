import { createHash } from "node:crypto";

// Construcción PURA (testeable) del user_data de Meta Conversions API.
// Regla de la integración CRM de Meta: los eventos de leads de formularios se
// identifican por `lead_id` (leadgen) con action_source "system_generated";
// los eventos de conversación siguen siendo "chat" con ph/ctwa_clid.

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Hash de teléfono según spec CAPI: solo dígitos, SHA-256. */
export function hashPhone(phone: string): string {
  return sha256(phone.replace(/[^\d]/g, ""));
}

/** Hash de email según spec CAPI: trim + minúsculas, SHA-256. */
export function hashEmail(email: string): string {
  return sha256(email.trim().toLowerCase());
}

export interface CapiIdentity {
  phone?: string | null;
  email?: string | null;
  /** leadgen_id del formulario de Meta Lead Ads (si el contacto vino de ahí) */
  leadgenId?: string | null;
  /** click id de anuncio Click-to-WhatsApp */
  ctwaClid?: string | null;
}

/** user_data con el máximo de identificadores disponibles (mejor match). */
export function buildUserData(id: CapiIdentity): Record<string, unknown> {
  return {
    ...(id.phone ? { ph: [hashPhone(id.phone)] } : {}),
    ...(id.email ? { em: [hashEmail(id.email)] } : {}),
    ...(id.leadgenId ? { lead_id: id.leadgenId } : {}),
    ...(id.ctwaClid ? { ctwa_clid: id.ctwaClid } : {}),
  };
}

/** action_source correcto: eventos de lead de formulario = system_generated. */
export function actionSourceFor(id: CapiIdentity): "system_generated" | "chat" {
  return id.leadgenId ? "system_generated" : "chat";
}
