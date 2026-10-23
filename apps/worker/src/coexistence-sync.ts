import { getAdminPrisma, withTenant } from "@conversia/database";

/**
 * SYNC de COEXISTENCIA (Meta "Onboard WhatsApp Business app users" + Phone Number First, oct-2026).
 * Tras conectar por coexistencia, Meta manda —a nivel WABA (entry.id = waba_id, SIN
 * metadata.phone_number_id, por eso parseWebhook los descarta)— estos campos:
 *   - `phone_number`        → el número quedó provisionado en la WABA (backfill del canal waba-only).
 *   - `smb_app_state_sync`  → contactos del teléfono del dueño (los sincronizamos).
 *   - `history`             → historial de chats (sincronizamos contactos + dejamos constancia;
 *                             la importación de MENSAJES va aparte, ver TODO).
 * Best-effort: nunca lanza (no debe tumbar el resto del webhook). Resuelve la org por waba_id.
 *
 * "UNA SOLA VEZ CADA UNO" (doc oficial, jun-2026): el sync de contactos y el de historial llegan
 * UNA vez cada uno dentro de las 24 h posteriores a conectar. Meta puede REENTREGAR el webhook
 * (reintentos) → dedupeamos por un evento MARCADOR por org y tipo (coexistence.state_sync_received /
 * coexistence.history_received): si ya existe, se ignora el reenvío (ni re-sync ni doble conteo).
 */

const SYNC_FIELDS = new Set(["phone_number", "smb_app_state_sync", "smb_app_data", "history"]);
const MARK_STATE_SYNC = "coexistence.state_sync_received";
const MARK_HISTORY = "coexistence.history_received";

interface Change {
  field: string;
  wabaId: string;
  value: Record<string, any>;
}

/** Extrae los cambios de sync de coexistencia (a nivel WABA) del webhook crudo. */
export function parseCoexistenceSync(raw: any): Change[] {
  const out: Change[] = [];
  const entries = Array.isArray(raw?.entry) ? raw.entry : [];
  for (const entry of entries) {
    const wabaId = String(entry?.id ?? "");
    for (const change of entry?.changes ?? []) {
      if (change?.field && SYNC_FIELDS.has(change.field)) {
        out.push({ field: change.field, wabaId, value: change.value ?? {} });
      }
    }
  }
  return out;
}

async function resolveOrgByWaba(wabaId: string): Promise<string | null> {
  if (!wabaId) return null;
  const acc = await getAdminPrisma().whatsappAccount.findFirst({ where: { wabaId }, select: { organizationId: true } });
  return acc?.organizationId ?? null;
}

/** Normaliza un teléfono a dígitos con "+" inicial (E.164 laxo), para deduplicar contactos. */
function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const d = String(p).replace(/[^\d]/g, "");
  return d ? `+${d}` : null;
}

/** Upsert de un contacto por teléfono dentro de la org (no duplica si ya existe). */
async function upsertContact(tx: any, organizationId: string, phone: string | null, name?: string | null): Promise<void> {
  const normalized = normPhone(phone);
  if (!normalized) return;
  const existing = await tx.contact.findFirst({ where: { organizationId, phone: normalized }, select: { id: true, firstName: true } });
  if (existing) {
    if (name && !existing.firstName) await tx.contact.update({ where: { id: existing.id }, data: { firstName: name } });
    return;
  }
  await tx.contact.create({ data: { organizationId, phone: normalized, firstName: name ?? null, source: "whatsapp_coexistence" } });
}

/** phone_number: el número ya está en la WABA → crea/reactiva la fila del número en el canal waba-only. */
async function handlePhoneNumber(organizationId: string, wabaId: string, value: Record<string, any>): Promise<void> {
  const phoneNumberId = String(value?.phone_number_id ?? value?.id ?? "");
  const displayPhone = String(value?.display_phone_number ?? phoneNumberId);
  if (!phoneNumberId) return;
  await withTenant(organizationId, async (tx) => {
    const account = await tx.whatsappAccount.findFirst({ where: { wabaId }, select: { id: true } });
    if (!account) return;
    const existing = await tx.whatsappPhoneNumber.findUnique({ where: { phoneNumberId }, select: { id: true } });
    // Canal de coexistencia pendiente de número (config.pendingNumber) o el más reciente del WABA.
    const channel = await tx.channelConnection.findFirst({ where: { type: "WHATSAPP_CLOUD" }, orderBy: { createdAt: "desc" }, select: { id: true, config: true } });
    if (!existing) {
      await tx.whatsappPhoneNumber.create({ data: { organizationId, accountId: account.id, channelConnectionId: channel?.id ?? null, phoneNumberId, displayPhone, status: "active" } });
    }
    if (channel) {
      const cfg = (channel.config as Record<string, unknown>) ?? {};
      if (cfg.pendingNumber) await tx.channelConnection.update({ where: { id: channel.id }, data: { status: "active", config: { ...cfg, pendingNumber: false } as object } });
    }
    await tx.integrationEvent.create({ data: { organizationId, provider: "whatsapp", type: "coexistence.phone_number", status: "ok", message: `Número de coexistencia provisionado: ${displayPhone}`, payload: { phoneNumberId, wabaId } } });
  });
}

/** ¿ya se procesó este sync para la org? (dedupe "una sola vez": el marcador es un IntegrationEvent). */
async function alreadySynced(tx: any, organizationId: string, markType: string): Promise<boolean> {
  const prev = await tx.integrationEvent.findFirst({ where: { organizationId, provider: "whatsapp", type: markType }, select: { id: true } });
  return Boolean(prev);
}

/** smb_app_state_sync: contactos del teléfono del dueño. Una sola vez por org. */
async function handleStateSync(organizationId: string, value: Record<string, any>): Promise<number> {
  const items = Array.isArray(value?.state_sync) ? value.state_sync : [];
  let n = 0;
  await withTenant(organizationId, async (tx) => {
    if (await alreadySynced(tx, organizationId, MARK_STATE_SYNC)) return; // reenvío de Meta → ignorar
    for (const it of items) {
      if (it?.type === "contact" && (it?.action ?? "add") === "add") {
        await upsertContact(tx, organizationId, it?.contact?.phone_number, it?.contact?.full_name);
        n++;
      }
    }
    // Marcador: sella que el sync de contactos ya ocurrió (dedupe de futuros reenvíos).
    await tx.integrationEvent.create({ data: { organizationId, provider: "whatsapp", type: MARK_STATE_SYNC, status: "ok", message: `Contactos de coexistencia sincronizados: ${n}.`, payload: { contacts: n } } });
  });
  return n;
}

/** history: sincroniza los contactos del historial y deja constancia (mensajes = TODO aparte). */
async function handleHistory(organizationId: string, value: Record<string, any>): Promise<void> {
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  // Contar mensajes del historial (puede venir como value.messages o value.history[].threads[].messages).
  let messageCount = Array.isArray(value?.messages) ? value.messages.length : 0;
  for (const h of Array.isArray(value?.history) ? value.history : []) {
    for (const t of Array.isArray(h?.threads) ? h.threads : []) {
      messageCount += Array.isArray(t?.messages) ? t.messages.length : 0;
    }
  }
  await withTenant(organizationId, async (tx) => {
    if (await alreadySynced(tx, organizationId, MARK_HISTORY)) return; // reenvío de Meta → ignorar
    for (const c of contacts) {
      await upsertContact(tx, organizationId, c?.wa_id ?? c?.phone_number, c?.profile?.name);
    }
    await tx.integrationEvent.create({
      data: {
        organizationId,
        provider: "whatsapp",
        type: MARK_HISTORY,
        status: "ok",
        message: `Historial de coexistencia recibido: ${contacts.length} contacto(s), ${messageCount} mensaje(s).`,
        // TODO(coexistencia): importar los mensajes del historial a las conversaciones (requiere
        // validar el shape real del payload `history`/`smb_app_data` contra una sesión en vivo).
        payload: { contacts: contacts.length, messages: messageCount },
      },
    });
  });
}

/** Procesa todos los cambios de sync de coexistencia del webhook. Best-effort por cambio. */
export async function processCoexistenceSync(raw: any): Promise<void> {
  for (const change of parseCoexistenceSync(raw)) {
    try {
      const organizationId = await resolveOrgByWaba(change.wabaId);
      if (!organizationId) continue; // WABA no es nuestra (p. ej. TuBot u otra) → ignorar
      if (change.field === "phone_number") await handlePhoneNumber(organizationId, change.wabaId, change.value);
      else if (change.field === "smb_app_state_sync" || change.field === "smb_app_data") await handleStateSync(organizationId, change.value);
      else if (change.field === "history") await handleHistory(organizationId, change.value);
    } catch (err) {
      console.error(`✖ coexistence-sync ${change.field}/${change.wabaId}:`, (err as Error).message);
    }
  }
}
