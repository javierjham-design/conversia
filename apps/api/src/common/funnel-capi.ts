import { getEnv } from "@conversia/config";
import { CAPI_FUNNEL_PROVIDER, HITOS_CAPI, decidirSenalCapi, type HitoCapi } from "@conversia/types";
import type { PrismaService } from "../prisma.service";
import type { QueueService } from "../queues";

/**
 * COP 4 — SEÑALES DEL EMBUDO hacia Meta Ads desde el API: **cuenta creada** y **plan
 * activado** (el worker informa "bot activo", que es lo único que ve él).
 *
 * La decisión de QUÉ se manda y CUÁNDO es la misma función para las dos puntas
 * (`decidirSenalCapi`, en `@conversia/types`): acá solo cambia la cola. Nace APAGADA
 * (`FUNNEL_CAPI_ENABLED=false`) porque mandarle eventos a Meta es irreversible —entrenan el
 * modelo del conjunto de anuncios— y hacerlo con datos de prueba ensucia la cuenta
 * publicitaria de forma que no se limpia.
 */
export async function informarHitoCapiApi(
  prisma: Pick<PrismaService, "admin">,
  queues: Pick<QueueService, "capi">,
  organizationId: string,
  hito: HitoCapi,
  opts: { valorClp?: number | null; contactId?: string | null } = {},
): Promise<{ enviado: boolean; motivo: string }> {
  try {
    const admin = prisma.admin;
    const org = await admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    const yaEnviado = Boolean(
      await admin.integrationEvent.findFirst({
        where: { organizationId, provider: CAPI_FUNNEL_PROVIDER, type: hito },
        select: { id: true },
      }),
    );
    const d = decidirSenalCapi({
      habilitado: getEnv().FUNNEL_CAPI_ENABLED === true,
      brand: (org?.brand ?? "tubot").toLowerCase(),
      hito,
      yaEnviado,
      valorClp: opts.valorClp,
    });
    if (!d.enviar) return { enviado: false, motivo: d.motivo };

    // El sello se escribe ANTES de encolar: si el proceso muere entre medio, preferimos
    // perder una señal a mandar un `Purchase` dos veces (un valor contado doble le enseña a
    // Meta que ese público paga el doble de lo que paga).
    await admin.integrationEvent.create({
      data: {
        organizationId,
        provider: CAPI_FUNNEL_PROVIDER,
        type: hito,
        payload: { evento: HITOS_CAPI[hito].evento, valorClp: opts.valorClp ?? null } as object,
      },
    });
    await queues.capi.add(
      "send",
      {
        organizationId,
        source: `funnel:${hito}`,
        occurredAt: new Date().toISOString(),
        eventName: HITOS_CAPI[hito].evento,
        value: HITOS_CAPI[hito].conValor ? (opts.valorClp ?? null) : null,
        currency: HITOS_CAPI[hito].conValor ? "CLP" : null,
        contactId: opts.contactId ?? null,
      },
      { attempts: 5, backoff: { type: "exponential", delay: 5000 } },
    );
    return { enviado: true, motivo: "ok" };
  } catch (e) {
    // Una señal de marketing que falla NO puede tumbar un registro ni un cobro.
    console.error(`✖ Señal CAPI del embudo (${hito}):`, (e as Error).message?.slice(0, 160));
    return { enviado: false, motivo: "error" };
  }
}
