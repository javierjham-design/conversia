/**
 * Purga por RETENCIÓN de datos (política por tenant en `org.settings.retention`).
 * Pura + tick. Default conservador: 0 meses = **indefinido** (no purga nada). El
 * tenant elige 6/12/24 meses en Configuración → Datos. Registra en audit_logs qué
 * purgó y cuándo, sin bloquear la operación (best-effort, por lotes).
 */

const DAY_MS = 86_400_000;

/** Fecha de corte para `months` meses atrás; null si 0/indefinido. */
export function retentionCutoff(months: number, now: Date = new Date()): Date | null {
  if (!Number.isFinite(months) || months <= 0) return null;
  return new Date(now.getTime() - Math.round(months * 30.4375 * DAY_MS));
}

/** Tick diario: aplica la retención de cada organización. */
export function startRetentionPurge(): () => void {
  const run = async () => {
    try {
      const { getAdminPrisma, withTenant } = await import("@conversia/database");
      const prisma = getAdminPrisma();
      const now = new Date();
      const orgs = await prisma.organization.findMany({ where: { deletedAt: null }, select: { id: true, settings: true } });
      for (const org of orgs) {
        const r = ((org.settings as Record<string, any>)?.retention ?? {}) as Record<string, any>;
        const convCut = retentionCutoff(Number(r.conversationsMonths ?? 0), now);
        const trxCut = retentionCutoff(Number(r.transcriptionsMonths ?? 0), now);
        if (!convCut && !trxCut) continue;

        await withTenant(org.id, async (tx) => {
          let deletedConvs = 0;
          let clearedTranscripts = 0;

          // 1. Conversaciones antiguas → borra la conversación (cascada de mensajes
          //    y adjuntos). Se conserva el contacto.
          if (convCut) {
            const old = await tx.conversation.findMany({
              where: { OR: [{ lastMessageAt: { lt: convCut } }, { lastMessageAt: null, createdAt: { lt: convCut } }] },
              select: { id: true },
              take: 5000,
            });
            if (old.length) {
              const res = await tx.conversation.deleteMany({ where: { id: { in: old.map((c) => c.id) } } });
              deletedConvs = res.count;
            }
          }

          // 2. Transcripciones de audio antiguas → borra el texto (body), conserva
          //    el registro del mensaje.
          if (trxCut) {
            const res = await tx.message.updateMany({
              where: { type: "AUDIO", body: { not: null }, createdAt: { lt: trxCut } },
              data: { body: null },
            });
            clearedTranscripts = res.count;
          }

          if (deletedConvs > 0 || clearedTranscripts > 0) {
            await tx.auditLog.create({
              data: {
                organizationId: org.id,
                actorType: "system",
                actorId: "retention",
                action: "data.retention_purge",
                after: { deletedConversations: deletedConvs, clearedTranscriptions: clearedTranscripts, conversationsCutoff: convCut, transcriptionsCutoff: trxCut },
              },
            });
          }
          // Marca de última purga (para mostrar en la UI).
          const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };
          settings.retention = { ...(settings.retention as object), lastPurgeAt: now.toISOString() };
          await tx.organization.update({ where: { id: org.id }, data: { settings: settings as object } });
        });
      }
    } catch (err) {
      console.error("✖ retention-purge tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, 24 * 60 * 60 * 1000); // diario
  interval.unref?.();
  return () => clearInterval(interval);
}
