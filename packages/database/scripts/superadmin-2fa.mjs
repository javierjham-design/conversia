#!/usr/bin/env node
/**
 * VER Y REINICIAR EL 2FA DE UN SUPER ADMIN.
 *
 * Por qué existe (28-oct-2026): el dueño entró con Google a la consola y el backend le pidió
 * un código de 2FA que él nunca enroló; todos los códigos salían inválidos y quedó afuera de
 * su propia plataforma. Para diagnosticarlo hay que mirar la fila de `platform_admins`, y no
 * había forma de hacerlo sin escribir SQL a mano contra producción.
 *
 * Hay exactamente dos maneras de quedar encerrado:
 *   · `mfaEnabledAt` puesto y el autenticador perdido (o nunca escaneado);
 *   · `mfaEnabledAt` puesto con `mfaSecret` en NULL → `verifyTotp` devuelve false SIEMPRE y
 *     ningún código del mundo entra. Los códigos de recuperación tampoco si la lista está vacía.
 *
 * SIN BANDERAS NO TOCA NADA: lista los super admins de la marca y qué los protege. No imprime
 * hashes ni secretos, solo si existen.
 *
 *   # 1) Ver (solo lectura)
 *   railway run -s Postgres -- node -e "process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;import('./scripts/superadmin-2fa.mjs')"
 *
 *   # 2) Reiniciar el 2FA de UNA cuenta para poder re-enrolarlo
 *   railway run -s Postgres -- node -e "process.env.SUPERADMIN_EMAIL='tu@correo';process.env.DATABASE_URL=process.env.DATABASE_PUBLIC_URL;process.argv.push('--reiniciar-2fa');import('./scripts/superadmin-2fa.mjs')"
 *
 * Correrlo desde `packages/database`. Variables: SUPERADMIN_EMAIL, BRAND (default conversia).
 *
 * OJO: reiniciar el 2FA BAJA la protección de esa cuenta hasta que la vuelvas a enrolar. Con
 * `SUPER_ADMIN_REQUIRE_MFA=true` (el default) la consola te manda derecho a /admin/security y
 * no te deja hacer nada más hasta que lo actives, así que la ventana es corta — pero es real:
 * hacelo y enrolá en la misma sesión.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BRAND = (process.env.BRAND ?? "conversia").trim().toLowerCase();
const EMAIL = (process.env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
const REINICIAR = process.argv.includes("--reiniciar-2fa");

function describe(a) {
  const rec = Array.isArray(a.mfaRecoveryCodes) ? a.mfaRecoveryCodes.length : 0;
  if (!a.mfaEnabledAt && !a.mfaSecret) return "2FA: NO enrolado → entrás solo con el primer factor";
  if (!a.mfaEnabledAt && a.mfaSecret) return "2FA: a medio enrolar (hay secreto, falta confirmar el código) → todavía entrás sin código";
  if (a.mfaEnabledAt && !a.mfaSecret)
    return `2FA: ACTIVO pero SIN SECRETO → ningún código puede funcionar${rec ? `; quedan ${rec} código(s) de recuperación` : " y no hay códigos de recuperación: cuenta ENCERRADA"}`;
  return `2FA: ACTIVO desde ${a.mfaEnabledAt.toISOString().slice(0, 10)} · ${rec} código(s) de recuperación sin usar`;
}

async function main() {
  const admins = await prisma.platformAdmin.findMany({
    where: { brand: BRAND },
    select: { id: true, email: true, name: true, role: true, mfaSecret: true, mfaEnabledAt: true, mfaRecoveryCodes: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n${admins.length} super admin(s) de la marca "${BRAND}":\n`);
  if (!admins.length) {
    console.log("  (ninguno) — nadie puede entrar a esta consola. Creá uno con create-conversia-superadmin.mjs.");
    return;
  }
  for (const a of admins) {
    console.log(`  · ${a.email}  [rol ${a.role}]  creado ${a.createdAt.toISOString().slice(0, 10)}`);
    console.log(`      ${describe(a)}`);
  }

  if (!REINICIAR) {
    console.log("\nNo toqué nada (modo lectura).");
    console.log("Para reiniciar el 2FA de una cuenta: SUPERADMIN_EMAIL=... y la bandera --reiniciar-2fa");
    return;
  }

  if (!EMAIL) {
    console.error("\n✖ --reiniciar-2fa necesita SUPERADMIN_EMAIL (a cuál de las de arriba).");
    process.exitCode = 1;
    return;
  }
  const admin = admins.find((a) => a.email === EMAIL);
  if (!admin) {
    console.error(`\n✖ No existe ${EMAIL} en la marca ${BRAND}. Mirá la lista de arriba: el correo tiene que calzar exacto.`);
    process.exitCode = 1;
    return;
  }
  if (!admin.mfaEnabledAt && !admin.mfaSecret) {
    console.log(`\n• ${EMAIL} ya está sin 2FA: no hay nada que reiniciar. Si aun así te piden un código, el problema es otro.`);
    return;
  }

  await prisma.platformAdmin.update({
    where: { id: admin.id },
    data: { mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodes: [] },
  });
  // Bajar el segundo factor de un OWNER es una acción de seguridad: queda asentada.
  await prisma.auditLog
    .create({
      data: {
        actorType: "script",
        actorId: "superadmin-2fa",
        action: "platform.mfa.reset",
        entityType: "platform_admin",
        entityId: admin.id,
        before: { email: admin.email, brand: BRAND, role: admin.role, mfaEnabledAt: admin.mfaEnabledAt, teniaSecreto: !!admin.mfaSecret },
      },
    })
    .catch(() => undefined);

  console.log(`\n✔ 2FA reiniciado para ${EMAIL} (${BRAND}).`);
  console.log("  Entrá AHORA y enrolalo de nuevo en /admin/security — hasta que lo hagas, esa cuenta");
  console.log("  está protegida solo por el primer factor (tu contraseña o tu cuenta de Google).");
}

main()
  .catch((e) => {
    console.error("✖", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
