import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { CAPI_FUNNEL_PROVIDER, HITOS_CAPI, decidirSenalCapi, type HitoCapi } from "@conversia/types";
import { enqueueCapiEvent } from "./platform-events";

/**
 * COP 4 — SEÑALES DEL EMBUDO HACIA META ADS, **apagadas por defecto**.
 *
 * La campaña va a optimizar por estos eventos, así que Meta tiene que recibir las señales
 * reales del negocio y no solo el clic: cuenta creada, bot atendiendo y plan activado (este
 * último con su valor en pesos, que es lo que le permite optimizar por ingreso y no por
 * volumen).
 *
 * **Nace apagado a propósito** (`FUNNEL_CAPI_ENABLED=false`): mandarle eventos a Meta es
 * irreversible —entrenan el modelo del conjunto de anuncios— y hacerlo con datos de prueba
 * o duplicados ensucia la cuenta publicitaria de forma que no se limpia. El dueño lo
 * enciende cuando la campaña esté lista, y mientras tanto la decisión de QUÉ se manda y
 * CUÁNDO queda escrita, versionada y con tests.
 *
 * Idempotencia: UNA señal por organización y por hito, con sello en `integration_events`.
 * Un reintento del worker, dos turnos del bot en paralelo o un barrido que vuelve a pasar
 * no pueden duplicar un `Purchase` — un valor contado dos veces le enseña a Meta que ese
 * público paga el doble de lo que paga.
 */

// Los hitos y la DECISIÓN viven en `@conversia/types`: los usan las dos puntas (el API
// informa cuenta creada y plan activado; el worker, bot activo). Con dos copias, el día que
// alguien renombre un evento la mitad de las señales llegaría con el nombre viejo.

/** ¿Está encendido el envío de señales del embudo? */
export function funnelCapiEnabled(): boolean {
  return getEnv().FUNNEL_CAPI_ENABLED === true;
}

/** Sello de "este hito ya se informó" (una fila por org+hito en `integration_events`). */
const PROVIDER = CAPI_FUNNEL_PROVIDER;

/**
 * Informa un hito del embudo a Meta, si corresponde. Nunca lanza: una señal de marketing
 * que falla no puede tumbar el registro de un cliente ni la respuesta de un bot.
 */
export async function informarHitoCapi(
  organizationId: string,
  hito: HitoCapi,
  opts: { valorClp?: number | null; contactId?: string | null } = {},
): Promise<{ enviado: boolean; motivo: string }> {
  try {
    const prisma = getAdminPrisma();
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    const yaEnviado = Boolean(
      await prisma.integrationEvent.findFirst({
        where: { organizationId, provider: PROVIDER, type: hito },
        select: { id: true },
      }),
    );
    const d = decidirSenalCapi({
      habilitado: funnelCapiEnabled(),
      brand: (org?.brand ?? "tubot").toLowerCase(),
      hito,
      yaEnviado,
      valorClp: opts.valorClp,
    });
    if (!d.enviar) return { enviado: false, motivo: d.motivo };

    // El sello se escribe ANTES de encolar: si el proceso muere entre medio, preferimos
    // perder una señal a mandar un Purchase dos veces (un valor contado doble le enseña a
    // Meta que ese público paga el doble).
    await prisma.integrationEvent.create({
      data: {
        organizationId,
        provider: PROVIDER,
        type: hito,
        payload: { evento: HITOS_CAPI[hito].evento, valorClp: opts.valorClp ?? null } as object,
      },
    });
    await enqueueCapiEvent({
      organizationId,
      source: `funnel:${hito}`,
      occurredAt: new Date().toISOString(),
      eventName: HITOS_CAPI[hito].evento,
      value: HITOS_CAPI[hito].conValor ? (opts.valorClp ?? null) : null,
      currency: HITOS_CAPI[hito].conValor ? "CLP" : null,
      contactId: opts.contactId ?? null,
    });
    return { enviado: true, motivo: "ok" };
  } catch (e) {
    console.error(`✖ Señal CAPI del embudo (${hito}):`, (e as Error).message?.slice(0, 160));
    return { enviado: false, motivo: "error" };
  }
}
