/**
 * CRE 3 — verificación del MEDIDOR DE CRÉDITOS contra un Postgres REAL.
 *
 * Por qué existe: las dos consultas que alimentan el medidor del cliente
 * (`leerMuestraConsumoCreditos` y `leerPromedioDelRubro`) son SQL crudo —`meta->>'…'`,
 * `SUM` sobre `Decimal`, `COUNT(DISTINCT)`, el join por rubro— y todos los tests que las
 * tocan reemplazan `@conversia/database` por un doble. O sea: nunca se habían EJECUTADO.
 * Un nombre de columna equivocado o un tipo que vuelve como string no se ve en typecheck y
 * aparecería recién el día del go-live, en la pantalla del primer cliente que pague.
 *
 * Corre con el ROL REAL DE LA APLICACIÓN (conversia_app, con RLS) para que el aislamiento
 * quede probado también: la muestra de una organización no puede incluir el consumo de
 * otra. Las fixtures se crean y se borran con el rol admin.
 *
 * Uso (igual que verify:isolation — el job `tenant-isolation` ya tiene las dos URLs):
 *   APP_DATABASE_URL="postgresql://conversia_app:...@host:port/db" \
 *   ADMIN_DATABASE_URL="postgresql://postgres:...@host:port/db" \
 *     npx tsx src/verify-credit-meter.ts
 *
 * Sale con código 1 si cualquier comprobación falla.
 */
import { PrismaClient } from "@prisma/client";
import { DIAS_MUESTRA_CREDITOS, leerMuestraConsumoCreditos, leerPromedioDelRubro } from "./credit-usage.js";

const appUrl = process.env.APP_DATABASE_URL;
const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!appUrl || !adminUrl) {
  console.error("Falta APP_DATABASE_URL (rol conversia_app) y/o ADMIN_DATABASE_URL.");
  process.exit(2);
}

const app = new PrismaClient({ datasources: { db: { url: appUrl } } });
const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });

/** Prefijo de las fixtures: todo lo que empiece así es de esta verificación y se borra. */
const PREFIJO = "verif-medidor-";
const RUBRO_CON_DATOS = `${PREFIJO}rubro-con-datos`;
const RUBRO_SIN_DATOS = `${PREFIJO}rubro-sin-datos`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.log(`  ✖ ${name} ${detail}`);
  }
}
function igual(name: string, actual: unknown, esperado: unknown) {
  check(name, actual === esperado, `→ esperaba ${String(esperado)}, llegó ${String(actual)} (${typeof actual})`);
}

/**
 * Lee la muestra como la lee la API: dentro del contexto de tenant, con el rol de la app.
 * `contexto` permite pedir la muestra de OTRA organización estando en el contexto propio,
 * que es la forma en que un bug de la API filtraría el consumo de un tenant a otro.
 */
async function muestraComoLaApp(orgId: string, opts: { dias?: number; contexto?: string } = {}) {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${opts.contexto ?? orgId}, true)`;
    return leerMuestraConsumoCreditos(tx as never, orgId, opts.dias);
  });
}

/**
 * Las fixtures van en medios días a propósito: `dias` se calcula con `Math.ceil` contra
 * `Date.now()`, así que un evento sembrado "hace exactamente 5 días" cae en 5 días + unos
 * milisegundos y redondea a 6. Con 4,5 el resultado es 5 con cualquier latencia razonable.
 */
const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000);

/** Un débito de créditos tal como lo escribe `debitAiCreditsForTurn`. */
function evento(organizationId: string, conversationId: string | null, creditos: number, diasAtras: number) {
  return {
    organizationId,
    type: "ai_credits",
    quantity: creditos,
    meta: conversationId ? { conversationId, model: "gpt-4o-mini" } : { model: "gpt-4o-mini" },
    occurredAt: hace(diasAtras),
  };
}

async function crearOrg(slug: string, rubro: string | null) {
  return admin.organization.create({
    data: {
      name: slug,
      slug,
      brand: "conversia",
      ...(rubro ? { settings: { general: { industry: rubro } } } : {}),
    },
    select: { id: true },
  });
}

async function limpiar() {
  const orgs = await admin.organization.findMany({ where: { slug: { startsWith: PREFIJO } }, select: { id: true } });
  if (!orgs.length) return;
  const ids = orgs.map((o) => o.id);
  await admin.usageEvent.deleteMany({ where: { organizationId: { in: ids } } });
  await admin.organization.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  console.log("== Medidor de créditos contra Postgres real (rol conversia_app) ==\n");
  await limpiar(); // por si una corrida anterior murió a mitad

  // ---------------------------------------------------------------- muestra propia
  console.log("Muestra de consumo propia (leerMuestraConsumoCreditos)");

  const mia = await crearOrg(`${PREFIJO}mia`, RUBRO_CON_DATOS);
  const vecina = await crearOrg(`${PREFIJO}vecina`, RUBRO_CON_DATOS);
  await admin.usageEvent.createMany({
    data: [
      // Conversación 1: DOS turnos del bot (1 + 3 créditos). Cuenta como UNA conversación.
      evento(mia.id, "conv-1", 1, 4.5),
      evento(mia.id, "conv-1", 3, 3.5),
      evento(mia.id, "conv-2", 2, 1.5),
      evento(mia.id, "conv-3", 1, 0.5),
      // Un débito SIN conversación (p. ej. un turno sin conversación asociada): suma
      // créditos pero no infla el número de conversaciones, o el promedio saldría bajo.
      evento(mia.id, null, 5, 0.5),
      // Ruido que NO debe entrar: otro tipo de evento y un débito fuera de la ventana.
      { organizationId: mia.id, type: "ai_tokens", quantity: 9999, meta: {}, occurredAt: hace(1) },
      evento(mia.id, "conv-vieja", 500, DIAS_MUESTRA_CREDITOS + 10),
      // La VECINA consume mucho: no puede aparecer en la muestra de la mía (RLS).
      ...Array.from({ length: 6 }, (_, i) => evento(vecina.id, `v-${i}`, 10, 2.5)),
    ],
  });

  const m = await muestraComoLaApp(mia.id);
  igual("cuenta conversaciones DISTINTAS, no turnos del bot", m.conversaciones, 3);
  igual("suma los créditos del período (Decimal → number)", m.creditos, 12);
  igual("los días son la ventana REAL con datos, no los 30 nominales", m.dias, 5);
  check("los tres campos vuelven como number", [m.conversaciones, m.creditos, m.dias].every((v) => typeof v === "number"));

  const ventanaCorta = await muestraComoLaApp(mia.id, { dias: 3 });
  igual("una ventana más corta recorta la muestra", ventanaCorta.conversaciones, 2);
  igual("y los días no superan la ventana pedida", ventanaCorta.dias, 2);

  // RLS: pedir la muestra de OTRA organización desde mi contexto no devuelve su consumo.
  // Es el único freno si algún día la API pasa el id equivocado.
  const ajena = await muestraComoLaApp(vecina.id, { contexto: mia.id });
  check(
    "la muestra de otra organización desde mi contexto vuelve en cero (RLS)",
    ajena.conversaciones === 0 && ajena.creditos === 0,
    `→ ${JSON.stringify(ajena)}`,
  );

  const sinNada = await crearOrg(`${PREFIJO}sin-consumo`, null);
  const vacia = await muestraComoLaApp(sinNada.id);
  check(
    "una cuenta sin consumo devuelve ceros (no null ni NaN)",
    vacia.conversaciones === 0 && vacia.creditos === 0 && vacia.dias === 0,
    `→ ${JSON.stringify(vacia)}`,
  );

  // ------------------------------------------------------------- promedio del rubro
  console.log("\nPromedio del rubro (leerPromedioDelRubro)");

  // Tres negocios del mismo rubro con 30 conversaciones y 90 créditos → promedio 3.
  const delRubro = [mia.id, vecina.id, (await crearOrg(`${PREFIJO}tercera`, RUBRO_CON_DATOS)).id];
  await admin.usageEvent.deleteMany({ where: { organizationId: { in: delRubro } } });
  await admin.usageEvent.createMany({
    data: delRubro.flatMap((orgId, o) => Array.from({ length: 10 }, (_, i) => evento(orgId, `r-${o}-${i}`, 3, 3))),
  });
  const promedio = await leerPromedioDelRubro(admin as never, RUBRO_CON_DATOS);
  igual("promedio = créditos / conversaciones del rubro", promedio, 3);

  // Dos negocios: por debajo del mínimo de 3 → null (no es el promedio de nadie).
  const pocos = [(await crearOrg(`${PREFIJO}poca-1`, RUBRO_SIN_DATOS)).id, (await crearOrg(`${PREFIJO}poca-2`, RUBRO_SIN_DATOS)).id];
  await admin.usageEvent.createMany({
    data: pocos.flatMap((orgId, o) => Array.from({ length: 20 }, (_, i) => evento(orgId, `p-${o}-${i}`, 3, 3))),
  });
  igual("con menos de 3 negocios devuelve null", await leerPromedioDelRubro(admin as never, RUBRO_SIN_DATOS), null);
  igual("un rubro sin datos devuelve null", await leerPromedioDelRubro(admin as never, `${PREFIJO}inexistente`), null);
  igual("rubro vacío devuelve null (no recorre la tabla entera)", await leerPromedioDelRubro(admin as never, ""), null);

  console.log(`\n${failed === 0 ? "✔" : "✖"} ${passed} comprobaciones OK · ${failed} fallidas`);
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(async () => {
    await limpiar().catch((e) => console.error("⚠ no se pudo limpiar las fixtures:", (e as Error).message));
    await app.$disconnect();
    await admin.$disconnect();
    process.exit(failed === 0 ? 0 : 1);
  });
