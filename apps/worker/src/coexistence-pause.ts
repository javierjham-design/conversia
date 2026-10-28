import { withTenant } from "@conversia/database";

/**
 * §5 — COEXISTENCIA: si el dueño contesta A MANO desde su app de WhatsApp, el bot se calla.
 *
 * En coexistencia el mismo número lo atienden dos: el bot (por la API) y el dueño (desde
 * su teléfono). Meta nos avisa de lo que escribe el dueño con un eco
 * (`smb_message_echoes`). Hasta ahora el eco solo se pintaba en la Bandeja, así que el
 * bot seguía respondiendo en paralelo: el cliente recibía dos respuestas a la misma cosa,
 * a veces contradictorias, y el dueño no se enteraba de que estaba compitiendo con su
 * propio bot.
 *
 * Ahora el eco se trata como lo que es —una toma de control humana— y reusa el modelo
 * `HumanHandoff` que ya existe, así la Bandeja lo muestra igual que cualquier otra toma de
 * control. El bot vuelve solo pasado el plazo (2 h por defecto), configurable POR CANAL en
 * `config.coexistenceAiPauseMinutes`.
 *
 * INERTE PARA TUBOT por construcción: solo actúa sobre canales con
 * `config.coexistence = true`, y las WABAs de TuBot no envían ecos.
 */

/** Plazo por defecto antes de que el bot retome, si el canal no define otro. */
export const COEX_PAUSE_MINUTES_DEFAULT = 120;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

function minutosDePausa(config: unknown): number {
  const n = Number((config as Record<string, unknown> | null)?.coexistenceAiPauseMinutes);
  // 0 o negativo = el dueño NO quiere pausa automática; se respeta.
  if (Number.isFinite(n) && n >= 0) return n;
  return COEX_PAUSE_MINUTES_DEFAULT;
}

/**
 * Pausa la IA de la conversación porque el dueño respondió desde su app.
 * Devuelve los minutos de pausa aplicados, o null si no correspondía (canal sin
 * coexistencia, pausa desactivada, o la IA ya estaba apagada).
 */
export async function pauseAiForOwnerEcho(
  organizationId: string,
  conversationId: string,
  channelConnectionId: string | null,
): Promise<number | null> {
  if (!channelConnectionId) return null;
  return withTenant(organizationId, async (tx: Tx) => {
    const channel = await tx.channelConnection.findFirst({
      where: { id: channelConnectionId, organizationId },
      select: { config: true },
    });
    // Solo coexistencia: en un canal normal el único que envía es el bot, y un eco no
    // debería existir. Si llegara, no se toca nada.
    if (((channel?.config as Record<string, unknown> | null)?.coexistence) !== true) return null;

    const minutos = minutosDePausa(channel?.config);
    if (minutos === 0) return null;

    const conv = await tx.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { aiEnabled: true, meta: true },
    });
    // Ya estaba en manos de un humano: no se re-anota ni se corre el plazo (si no, cada
    // mensaje que escriba el dueño empujaría la vuelta del bot indefinidamente... que es
    // justo lo que SÍ queremos; pero sin duplicar el handoff ni la nota).
    const yaPausada = conv?.aiEnabled === false;
    const resumeAt = new Date(Date.now() + minutos * 60_000);
    const meta = { ...((conv?.meta as Record<string, unknown>) ?? {}) };
    meta.coexistence = { ...((meta.coexistence as Record<string, unknown>) ?? {}), aiResumeAt: resumeAt.toISOString() };

    await tx.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: false, meta: meta as object },
    });

    if (yaPausada) return minutos; // solo se corrió el plazo
    await tx.humanHandoff.create({
      data: {
        organizationId,
        conversationId,
        requestedBy: "app", // el dueño, desde su WhatsApp
        reason: `Respondiste desde tu WhatsApp: el bot queda en pausa ${minutos} min`,
        status: "ACTIVE",
        takenAt: new Date(),
      },
    });
    await tx.message.create({
      data: {
        organizationId,
        conversationId,
        direction: "OUTBOUND",
        type: "SYSTEM",
        visibility: "INTERNAL",
        body: `🤫 Respondiste desde tu WhatsApp, así que el bot no contesta en este chat. Retoma solo en ${minutos} min (o actívalo desde la Bandeja).`,
        authorType: "SYSTEM",
        status: "DELIVERED",
      },
    });
    return minutos;
  });
}

/**
 * Devuelve el control al bot en las conversaciones cuya pausa por coexistencia ya venció.
 *
 * La reanudación es por PLAZO guardado en la conversación (`meta.coexistence.aiResumeAt`),
 * no por un trabajo programado: así no hay nada que se pueda perder si el worker se
 * reinicia, y el plazo por canal se respeta sin inventar un scheduler nuevo.
 */
export async function resumeCoexistencePauses(organizationId: string): Promise<number> {
  const ahora = new Date();
  const candidatas = await withTenant(organizationId, (tx: Tx) =>
    tx.conversation.findMany({
      where: { organizationId, aiEnabled: false, status: { in: ["OPEN", "PENDING"] } },
      select: { id: true, meta: true },
      take: 200,
    }),
  );
  const vencidas = candidatas.filter((c) => {
    const at = ((c.meta as Record<string, any> | null)?.coexistence?.aiResumeAt) as string | undefined;
    return !!at && new Date(at) <= ahora;
  });
  for (const c of vencidas) {
    await withTenant(organizationId, async (tx: Tx) => {
      const meta = { ...((c.meta as Record<string, unknown>) ?? {}) };
      const coex = { ...((meta.coexistence as Record<string, unknown>) ?? {}) };
      delete coex.aiResumeAt;
      meta.coexistence = coex;
      await tx.conversation.update({ where: { id: c.id }, data: { aiEnabled: true, meta: meta as object } });
      await tx.humanHandoff.updateMany({
        where: { organizationId, conversationId: c.id, status: "ACTIVE", requestedBy: "app" },
        data: { status: "RETURNED_TO_AI", resolvedAt: ahora },
      });
      await tx.message.create({
        data: {
          organizationId,
          conversationId: c.id,
          direction: "OUTBOUND",
          type: "SYSTEM",
          visibility: "INTERNAL",
          body: "🤖 El bot retomó este chat (venció la pausa por tu respuesta desde WhatsApp).",
          authorType: "SYSTEM",
          status: "DELIVERED",
        },
      });
    }).catch(() => undefined);
  }
  return vencidas.length;
}
