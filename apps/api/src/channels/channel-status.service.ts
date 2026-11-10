import { Injectable, NotFoundException } from "@nestjs/common";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret } from "../common/crypto";
import { armarReporte, consultarNumero, consultarPagina, consultarSuscripcionWaba, esCanalDePagina, type ReporteDeCanal } from "./channel-status";
import { listWabaPhoneNumbers } from "./whatsapp-onboard";

/**
 * A1 — el IO del reporte de conexión: base, Graph y caché. Las decisiones viven en
 * `channel-status.ts` (puro y con tests).
 *
 * **Caché de 60 s por canal.** La pantalla hace polling cada 5 s mientras el dueño prueba su
 * número; sin caché, dos minutos de prueba serían ~48 pares de llamadas a Graph por cliente.
 * Si Redis no está, se consulta igual (la caché es un ahorro, no un requisito).
 *
 * **Este endpoint NO escribe.** Es un GET y se deja leer en bucle: marcar el canal como caído
 * desde acá convertiría un hipo de Graph en un cambio de estado del canal. Un token muerto se
 * ve igual (`tokenHealthy: false` + el chequeo del acceso), y quien cambia el estado sigue
 * siendo el worker cuando un envío real falla.
 */
@Injectable()
export class ChannelStatusService {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });

  constructor(private prisma: PrismaService) {
    this.redis.on("error", () => undefined); // que Redis caído no tumbe la petición
  }

  private clave(organizationId: string, channelId: string): string {
    return `conversia:canal:estado:${organizationId}:${channelId}`;
  }

  /** Borra la caché de un canal: lo usa el botón de probar, que tiene que leer el estado de AHORA. */
  async invalidar(organizationId: string, channelId: string): Promise<void> {
    await this.redis.del(this.clave(organizationId, channelId)).catch(() => undefined);
  }

  async reporte(organizationId: string, channelId: string, opts: { sinCache?: boolean } = {}): Promise<ReporteDeCanal> {
    const clave = this.clave(organizationId, channelId);
    if (!opts.sinCache) {
      const guardado = await this.redis.get(clave).catch(() => null);
      if (guardado) {
        try {
          return JSON.parse(guardado) as ReporteDeCanal;
        } catch {
          /* caché corrupta → se recalcula */
        }
      }
    }

    const datos = await this.cargarDeLaBase(organizationId, channelId);
    const env = getEnv();

    // C1 — Instagram y Messenger: lo que puede fallar es el acceso a la PÁGINA y que la app
    // esté suscrita a `messages`. El token de página se deriva del de la conexión de Meta.
    if (esCanalDePagina(datos.canal.type)) {
      const pageId = String((datos.canal.config as Record<string, unknown>)?.pageId ?? "");
      const pagina = pageId && datos.tokenMetaCrm ? await consultarPagina(pageId, datos.tokenMetaCrm, env.META_CRM_APP_ID ?? "") : null;
      const reporteDePagina = armarReporte({
        canal: datos.canal,
        defaultAgent: datos.defaultAgent,
        numeroLocal: null,
        wabaId: null,
        graph: null,
        suscripcion: null,
        accountAlert: datos.accountAlert,
        lastInboundAt: datos.lastInboundAt,
        lastOutboundAt: datos.lastOutboundAt,
        sinToken: !datos.tokenMetaCrm,
        pagina,
        reviewApproved: env.META_MESSAGING_REVIEW_APPROVED === true,
      });
      await this.redis.set(clave, JSON.stringify(reporteDePagina), "EX", 60).catch(() => undefined);
      return reporteDePagina;
    }

    // Graph: dos llamadas como máximo (los campos del número van juntos a propósito).
    let graph = datos.phoneNumberId && datos.token ? await consultarNumero(datos.phoneNumberId, datos.token) : null;
    const suscripcion = datos.wabaId && datos.token ? await consultarSuscripcionWaba(datos.wabaId, datos.token, env.META_APP_ID ?? "") : null;

    // Canal waba-only (coexistencia recién conectada): preguntarle a la WABA si el número ya
    // apareció. Así la pantalla puede mostrarlo en cuanto Meta lo publica, sin esperar a que
    // el webhook `phone_number` haga el backfill (que es lo que tardaba "unos minutos").
    let numeroLocal: { phoneNumberId: string; displayPhone: string | null } | null = datos.numeroLocal;
    if (!numeroLocal && datos.wabaId && datos.token) {
      const nums = await listWabaPhoneNumbers(datos.wabaId, datos.token);
      if (nums[0]) {
        numeroLocal = { phoneNumberId: nums[0].id, displayPhone: nums[0].displayPhone };
        graph = {
          ok: true,
          tokenVencido: false,
          displayPhone: nums[0].displayPhone,
          verifiedName: nums[0].verifiedName,
          qualityRating: null,
          coexVerified: nums[0].coexVerified,
          error: null,
        };
      }
    }

    const reporte = armarReporte({
      canal: datos.canal,
      defaultAgent: datos.defaultAgent,
      numeroLocal,
      wabaId: datos.wabaId,
      graph,
      suscripcion,
      accountAlert: datos.accountAlert,
      lastInboundAt: datos.lastInboundAt,
      lastOutboundAt: datos.lastOutboundAt,
      sinToken: !datos.token,
    });

    await this.redis.set(clave, JSON.stringify(reporte), "EX", 60).catch(() => undefined);
    return reporte;
  }

  /** Todo lo que el reporte necesita de la base, en una sola transacción por tenant. */
  private async cargarDeLaBase(organizationId: string, channelId: string) {
    const hace7dias = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    return this.prisma.withTenant(organizationId, async (tx) => {
      const canal = await tx.channelConnection.findUnique({ where: { id: channelId } });
      // `withTenant` ya acota por RLS: un canal de otra organización no existe acá.
      if (!canal) throw new NotFoundException("Canal no encontrado");

      const agente = canal.defaultAgentId
        ? await tx.agent.findUnique({ where: { id: canal.defaultAgentId }, select: { id: true, name: true } })
        : null;

      const numero = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: channelId }, select: { phoneNumberId: true, displayPhone: true, accountId: true } });
      // Sin fila de número (canal waba-only) la cuenta no se puede alcanzar por el número:
      // se toma la de la organización, que es la que acaba de crear la conexión. Es la misma
      // resolución que hace el webhook de coexistencia, al revés.
      const cuenta = numero
        ? await tx.whatsappAccount.findUnique({ where: { id: numero.accountId }, select: { wabaId: true, credentialId: true } })
        : await tx.whatsappAccount.findFirst({ orderBy: { createdAt: "desc" }, select: { wabaId: true, credentialId: true } });

      const credencial = cuenta?.credentialId
        ? await tx.integrationCredential.findUnique({ where: { id: cuenta.credentialId }, select: { ciphertext: true } })
        : null;

      // C1 — token de la conexión de Meta del tenant (del que se deriva el de página).
      let tokenMetaCrm: string | null = null;
      if (esCanalDePagina(String(canal.type))) {
        const conn = await tx.metaCrmConnection.findUnique({ where: { organizationId }, select: { status: true, credentialId: true } });
        if (conn?.status === "CONNECTED" && conn.credentialId) {
          const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId }, select: { ciphertext: true } });
          tokenMetaCrm = cred ? safeDecrypt(cred.ciphertext) : null;
        }
      }

      const alerta = await tx.integrationEvent.findFirst({
        where: { provider: "whatsapp", status: { in: ["warning", "error"] }, createdAt: { gte: hace7dias } },
        orderBy: { createdAt: "desc" },
        select: { type: true, message: true, createdAt: true },
      });

      // Última actividad del canal: los mensajes cuelgan de la conversación, y la conversación
      // es la que sabe por qué canal entró.
      const convs = await tx.conversation.findMany({ where: { channelConnectionId: channelId }, select: { id: true }, take: 500 });
      const ids = convs.map((c) => c.id);
      const [entrante, saliente] = ids.length
        ? await Promise.all([
            tx.message.findFirst({ where: { conversationId: { in: ids }, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
            tx.message.findFirst({ where: { conversationId: { in: ids }, direction: "OUTBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
          ])
        : [null, null];

      return {
        canal: { id: canal.id, type: String(canal.type), name: canal.name, status: canal.status, config: ((canal.config as Record<string, unknown>) ?? {}) },
        defaultAgent: agente ? { id: agente.id, name: agente.name } : null,
        numeroLocal: numero ? { phoneNumberId: numero.phoneNumberId, displayPhone: numero.displayPhone } : null,
        phoneNumberId: numero?.phoneNumberId ?? null,
        wabaId: cuenta?.wabaId ?? null,
        token: credencial ? safeDecrypt(credencial.ciphertext) : null,
        tokenMetaCrm,
        accountAlert: alerta ? { type: alerta.type, message: alerta.message, at: alerta.createdAt.toISOString() } : null,
        lastInboundAt: entrante?.createdAt.toISOString() ?? null,
        lastOutboundAt: saliente?.createdAt.toISOString() ?? null,
      };
    });
  }
}

/** Un secreto ilegible (rotación de clave) no puede tumbar el reporte: se trata como "sin token". */
function safeDecrypt(ciphertext: string): string | null {
  try {
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}
