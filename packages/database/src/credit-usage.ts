import { Prisma, type TenantTx } from "./index.js";

/**
 * CRE 3 — la MUESTRA DE CONSUMO que alimenta el estimador de créditos.
 *
 * Vive acá, en una sola consulta, porque la usan dos superficies que NO pueden decir
 * números distintos del mismo saldo: el panel (medidor en Inicio, Cobros y el copiloto) y
 * el worker (avisos al 75%, 90% y 0). Si cada uno la calculara a su manera, el dueño vería
 * "≈ 18 días" en pantalla y "≈ 6 días" en el aviso del mismo momento, y dejaría de creerle
 * a los dos.
 *
 * Sale de `usage_events` de tipo `ai_credits`, que es la fila que escribe el débito por
 * turno (`debitAiCreditsForTurn`): `quantity` son los créditos y `meta.conversationId`
 * identifica la conversación. Las conversaciones se cuentan DISTINTAS porque una
 * conversación son varios turnos del bot y lo que se estima es "cuántas conversaciones más
 * me alcanzan", no cuántas respuestas.
 */

export interface MuestraConsumoCreditos {
  conversaciones: number;
  creditos: number;
  dias: number;
}

/** Período por defecto del estimador (§"Etapa 3": últimos 30 días). */
export const DIAS_MUESTRA_CREDITOS = 30;

/**
 * Consumo de créditos de la organización en los últimos `dias`. Debe correr DENTRO de
 * `withTenant` (la RLS acota por `app.org_id`), y además filtra por `organization_id`
 * explícito: doble candado, igual que el resto de las consultas de tenant.
 *
 * `dias` es la ventana REAL con datos, no la nominal: si la cuenta tiene 4 días de uso, el
 * ritmo diario se calcula sobre 4 y no sobre 30, que daría un consumo diario siete veces
 * menor y una estimación de días siete veces optimista.
 */
export async function leerMuestraConsumoCreditos(
  tx: TenantTx,
  organizationId: string,
  dias: number = DIAS_MUESTRA_CREDITOS,
): Promise<MuestraConsumoCreditos> {
  const desde = new Date(Date.now() - dias * 86_400_000);
  const rows = await tx.$queryRaw<{ conversaciones: bigint; creditos: Prisma.Decimal | null; primero: Date | null }[]>`
    SELECT
      COUNT(DISTINCT meta->>'conversationId')          AS conversaciones,
      COALESCE(SUM(quantity), 0)                       AS creditos,
      MIN(occurred_at)                                 AS primero
    FROM usage_events
    WHERE organization_id = ${organizationId}
      AND type = 'ai_credits'
      AND occurred_at >= ${desde}
  `;
  const r = rows[0];
  const creditos = r?.creditos ? Number(r.creditos) : 0;
  const conversaciones = r?.conversaciones ? Number(r.conversaciones) : 0;
  // Días con datos de verdad: desde el primer evento de la ventana hasta hoy, mínimo 1.
  const diasConDatos = r?.primero
    ? Math.max(1, Math.min(dias, Math.ceil((Date.now() - new Date(r.primero).getTime()) / 86_400_000)))
    : 0;
  return { conversaciones, creditos, dias: diasConDatos };
}

/**
 * Promedio de créditos por conversación del RUBRO, para las cuentas que todavía no tienen
 * muestra propia. Se calcula con las orgs del mismo rubro que SÍ tienen historia.
 *
 * Va con el cliente admin (cruza organizaciones a propósito: es un agregado del rubro, no
 * datos de un tenant) y devuelve `null` si no hay suficiente para decir algo: un promedio
 * armado con dos cuentas no es el promedio del rubro, y es mejor caer al valor general que
 * mostrarle al dueño un número con cara de dato.
 */
export async function leerPromedioDelRubro(
  admin: { $queryRaw: TenantTx["$queryRaw"] },
  rubro: string,
  dias: number = DIAS_MUESTRA_CREDITOS,
): Promise<number | null> {
  if (!rubro) return null;
  const desde = new Date(Date.now() - dias * 86_400_000);
  const rows = await admin.$queryRaw<{ orgs: bigint; conversaciones: bigint; creditos: Prisma.Decimal | null }[]>`
    SELECT
      COUNT(DISTINCT u.organization_id)                  AS orgs,
      COUNT(DISTINCT u.meta->>'conversationId')          AS conversaciones,
      COALESCE(SUM(u.quantity), 0)                       AS creditos
    FROM usage_events u
    JOIN organizations o ON o.id = u.organization_id
    WHERE u.type = 'ai_credits'
      AND u.occurred_at >= ${desde}
      AND o.settings -> 'general' ->> 'industry' = ${rubro}
  `;
  const r = rows[0];
  const orgs = r?.orgs ? Number(r.orgs) : 0;
  const conversaciones = r?.conversaciones ? Number(r.conversaciones) : 0;
  const creditos = r?.creditos ? Number(r.creditos) : 0;
  // Al menos 3 negocios y 30 conversaciones: por debajo de eso es la media de nadie.
  if (orgs < 3 || conversaciones < 30 || creditos <= 0) return null;
  return creditos / conversaciones;
}
