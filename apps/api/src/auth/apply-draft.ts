/**
 * COP Etapa 0 — aplicar al registrarse lo que el cliente ya cargó en `/crear`.
 *
 * El problema (hallazgo 5 de `docs/PROMPT_COPILOTO_MONTAJE.md`): del borrador solo se usaba
 * el RUBRO. El nombre del negocio, la web y —lo importante— el **texto leído del sitio del
 * cliente** se tiraban. Resultado: el cliente prueba en `/crear` un bot que habla de SU
 * negocio, se registra, y recibe uno genérico del rubro. Es la peor primera impresión
 * posible y además lo obliga a reescribir lo que ya había dado.
 *
 * Qué hace ahora:
 *  1. Guarda en la organización la web y el texto leído (`settings.business`), para que
 *     queden disponibles para el copiloto y el panel.
 *  2. **Anexa** ese texto al prompt de los agentes que el paquete del rubro instaló como
 *     borrador, con el mismo bloque que usa el simulador de `/crear`.
 *
 * Es ANEXAR, nunca pisar: lo que trae el paquete del rubro se conserva intacto. Y es
 * idempotente: si el bloque ya está, no se duplica.
 */

/** Encabezado del bloque; sirve también de marca para no duplicarlo. */
const BLOQUE = "Información leída del sitio del negocio:";

export interface DraftConfigLike {
  scrapedText?: unknown;
  businessName?: unknown;
}

export interface ApplyDraftInput {
  businessName: string;
  website: string | null;
  config: unknown;
}

export interface ApplyDraftResult {
  settingsUpdated: boolean;
  agentsUpdated: number;
  scrapedChars: number;
}

/** Vista mínima del cliente de BD (permite mockearlo en tests). */
export type ApplyDraftTx = {
  organization: {
    findUnique: (args: any) => Promise<{ settings: unknown } | null>;
    update: (args: any) => Promise<unknown>;
  };
  agentVersion: {
    findMany: (args: any) => Promise<Array<{ id: string; systemPrompt: string | null }>>;
    update: (args: any) => Promise<unknown>;
  };
};

/** Texto del scrape, acotado y limpio; `null` si no hay nada aprovechable. */
export function scrapedTextFrom(config: unknown): string | null {
  const c = (config ?? {}) as DraftConfigLike;
  const t = typeof c.scrapedText === "string" ? c.scrapedText.trim() : "";
  return t.length >= 20 ? t.slice(0, 2000) : null; // menos de 20 caracteres no aporta nada
}

/** Anexa el bloque al prompt si todavía no está. Devuelve `null` si no hay que tocar nada. */
export function promptConScrape(systemPrompt: string | null, scraped: string): string | null {
  const base = systemPrompt ?? "";
  if (base.includes(BLOQUE)) return null; // ya aplicado: idempotente
  return `${base}\n\n${BLOQUE}\n${scraped}`.trim();
}

export async function applyDraftToOrganization(
  tx: ApplyDraftTx,
  organizationId: string,
  draft: ApplyDraftInput,
): Promise<ApplyDraftResult> {
  const scraped = scrapedTextFrom(draft.config);

  // 1. Guardar los datos del borrador en la organización (sin pisar el resto de settings).
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const settings = { ...((org?.settings ?? {}) as Record<string, unknown>) };
  const business = { ...((settings.business ?? {}) as Record<string, unknown>) };
  if (draft.website) business.website = draft.website;
  if (draft.businessName) business.nombre = draft.businessName;
  if (scraped) business.scrapedText = scraped;
  settings.business = business;
  await tx.organization.update({ where: { id: organizationId }, data: { settings: settings as object } });

  // 2. Anexar el texto del sitio al prompt de los agentes instalados (que están en BORRADOR).
  let agentsUpdated = 0;
  if (scraped) {
    const versions = await tx.agentVersion.findMany({
      where: { organizationId, status: "DRAFT" },
      select: { id: true, systemPrompt: true },
    });
    for (const v of versions) {
      const nuevo = promptConScrape(v.systemPrompt, scraped);
      if (!nuevo) continue;
      await tx.agentVersion.update({ where: { id: v.id }, data: { systemPrompt: nuevo } });
      agentsUpdated++;
    }
  }

  return { settingsUpdated: true, agentsUpdated, scrapedChars: scraped?.length ?? 0 };
}
