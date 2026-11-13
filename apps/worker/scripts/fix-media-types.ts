/**
 * REPARACIÓN D1 — mensajes históricos guardados con el tipo equivocado.
 *
 * Hasta D1, el worker conocía cuatro tipos (audio, imagen, documento, video) y TODO lo demás
 * se guardaba como `TEXT` con el cuerpo `"[" + tipo + "]"`. Es decir: cada sticker, cada
 * ubicación y cada ficha de contacto que recibió un cliente quedó en la base como un texto
 * que dice `[sticker]`. Ningún panel puede dibujarlos porque no hay forma de saber qué son
 * mirando `type`.
 *
 * La buena noticia es que el `payload` crudo del webhook SÍ se guardó siempre. De ahí sale el
 * tipo real: `payload.type`. Este script lee ese campo y corrige `type` y `body`.
 *
 * QUÉ **NO** HACE, a propósito:
 *  - No toca `lastMessagePreview` de las conversaciones. Esa columna es una foto del ÚLTIMO
 *    mensaje; reescribirla para mensajes viejos cambiaría la vista previa de conversaciones
 *    cuyo último mensaje es otro. La UI de D3 traduce los `[tipo]` históricos que queden.
 *  - No toca mensajes que ya tienen un tipo distinto de TEXT: si alguien ya los arregló, o si
 *    el tipo vino bien, no hay nada que hacer. Por eso es IDEMPOTENTE: correrlo dos veces
 *    deja el mismo resultado.
 *  - No toca `payload`. El crudo del webhook es la fuente de verdad y queda intacto.
 *
 * Uso (desde apps/worker):
 *   npx tsx scripts/fix-media-types.ts                      # simula TODAS las orgs
 *   npx tsx scripts/fix-media-types.ts --org=<id>           # simula una
 *   npx tsx scripts/fix-media-types.ts --aplicar            # escribe
 *
 * `--dry-run` se acepta por costumbre, pero es el comportamiento por defecto: sin `--aplicar`
 * no se escribe nada.
 */
import { getAdminPrisma, withTenant } from "@conversia/database";
import { mapInboundType, mediaPlaceholder, type TipoDeMensaje } from "../src/message-type";

const APLICAR = process.argv.includes("--aplicar");
const ORG = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;

/** Solo estos tipos se reparan: los que el worker viejo mandaba a TEXT. */
const REPARABLES = new Set(["sticker", "location", "contacts"]);

interface Resumen {
  org: string;
  revisados: number;
  porTipo: Record<string, number>;
}

async function repararOrg(organizationId: string, slug: string): Promise<Resumen> {
  const porTipo: Record<string, number> = {};
  let revisados = 0;

  await withTenant(organizationId, async (tx) => {
    // Solo los TEXT: un mensaje ya tipado no se toca (idempotencia).
    const candidatos = await tx.message.findMany({
      where: { type: "TEXT" },
      select: { id: true, body: true, payload: true },
    });

    for (const m of candidatos) {
      const crudo = (m.payload as Record<string, unknown> | null)?.type;
      const waType = typeof crudo === "string" ? crudo.toLowerCase() : null;
      if (!waType || !REPARABLES.has(waType)) continue;

      const tipo = mapInboundType(waType) as TipoDeMensaje;
      if (tipo === "TEXT") continue; // defensa: si el mapeo no lo reconoce, no inventamos

      revisados++;
      porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;

      if (APLICAR) {
        await tx.message.update({
          where: { id: m.id },
          // El body se recalcula desde el payload: así una ubicación recupera su nombre y
          // dirección, que estaban ahí guardados y nadie mostraba.
          data: { type: tipo as never, body: mediaPlaceholder(tipo, m.payload) },
        });
      }
    }
  });

  return { org: slug, revisados, porTipo };
}

async function main() {
  console.log(APLICAR ? "=== APLICANDO ===" : "=== SIMULACIÓN (sin --aplicar no escribe nada) ===");
  const admin = getAdminPrisma();
  const orgs = await admin.organization.findMany({
    where: { deletedAt: null, ...(ORG ? { id: ORG } : {}) },
    select: { id: true, slug: true },
    orderBy: { createdAt: "asc" },
  });
  if (!orgs.length) {
    console.log("No hay organizaciones que revisar.");
    return;
  }

  const totales: Record<string, number> = {};
  let total = 0;
  for (const o of orgs) {
    const r = await repararOrg(o.id, o.slug);
    if (!r.revisados) continue;
    total += r.revisados;
    for (const [k, v] of Object.entries(r.porTipo)) totales[k] = (totales[k] ?? 0) + v;
    console.log(`  ${o.slug}: ${r.revisados} mensaje(s) → ${Object.entries(r.porTipo).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  console.log(`\nTOTAL: ${total} mensaje(s) en ${orgs.length} organización(es) revisadas`);
  for (const [k, v] of Object.entries(totales)) console.log(`  ${k}: ${v}`);
  if (!total) console.log("  (nada que reparar)");
  if (!APLICAR && total) console.log("\n(simulación: no se escribió nada. Volvé a correrlo con --aplicar)");
}

main()
  .catch((e) => {
    console.error("FALLÓ:", (e as Error).message);
    process.exit(1);
  })
  .finally(() => getAdminPrisma().$disconnect());
