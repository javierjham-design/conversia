#!/usr/bin/env node
/**
 * CERRAR LA PUERTA TRASERA DEL SANDBOX.
 *
 * `seed-sandbox.mjs` crea un super admin con rol OWNER y MFA de secreto CONOCIDO para que
 * se pueda entrar a la consola sin escanear un QR. Es útil mientras duran las pruebas y es
 * una puerta trasera en cuanto dejan de durar: la base de Conversia es la misma de TuBot y
 * de los clientes reales. Encima, sus credenciales terminaron escritas en un documento del
 * repo (`docs/HANDOFF_PLANNER_BLOQUE_B.md`), así que el secreto hay que darlo por quemado:
 * mientras la cuenta exista, lo publicado sigue sirviendo.
 *
 * Este script la borra. Es idempotente (si no existe, lo dice) y acotado: borra EXACTAMENTE
 * `sandbox.admin@conversia.cl` de la marca conversia, nunca una cuenta por patrón.
 *
 *   railway run -s Postgres -- bash -c 'cd packages/database && \
 *     DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/sandbox-cerrar.mjs'
 *
 * Opciones:
 *   --suspender-tenant   además pasa la org sandbox a SUSPENDED (no la borra: su historial
 *                        de caja es append-only y no se toca).
 *   --igual              borra el admin incluso si es el ÚLTIMO super admin de Conversia
 *                        (sin esto se niega, para no dejarte afuera de tu propia consola).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EMAIL = "sandbox.admin@conversia.cl";
const BRAND = "conversia";
const TENANT_SLUG_O_ID = process.env.TENANT_ORG_ID || "";
const SUSPENDER = process.argv.includes("--suspender-tenant");
const IGUAL = process.argv.includes("--igual");

async function main() {
  const admin = await prisma.platformAdmin.findUnique({ where: { email_brand: { email: EMAIL, brand: BRAND } } });
  if (!admin) {
    console.log(`✔ ${EMAIL} (${BRAND}) no existe: la puerta ya está cerrada.`);
  } else {
    const total = await prisma.platformAdmin.count({ where: { brand: BRAND } });
    if (total <= 1 && !IGUAL) {
      console.error(
        `✖ ${EMAIL} es el ÚNICO super admin de ${BRAND}: borrarlo te deja sin acceso a la consola.\n` +
          "  Creá tu super admin propio primero (scripts/create-conversia-superadmin.mjs) y volvé a correr esto.\n" +
          "  Si de verdad querés borrarlo igual: --igual",
      );
      process.exitCode = 1;
      return;
    }
    await prisma.platformAdmin.delete({ where: { id: admin.id } });
    // El borrado queda asentado: es una acción de seguridad y tiene que poder auditarse.
    await prisma.auditLog
      .create({
        data: {
          actorType: "script",
          actorId: "sandbox-cerrar",
          action: "platform.admin.deleted",
          entityType: "platform_admin",
          entityId: admin.id,
          before: { email: EMAIL, brand: BRAND, role: admin.role, motivo: "cierre de la puerta trasera del sandbox" },
        },
      })
      .catch(() => undefined);
    console.log(`✔ Super admin ${EMAIL} (${BRAND}) BORRADO. Quedan ${total - 1} super admin(s) de ${BRAND}.`);
    console.log("  El secreto TOTP publicado ya no sirve para nada.");
  }

  if (SUSPENDER) {
    const org = TENANT_SLUG_O_ID
      ? await prisma.organization.findFirst({ where: { OR: [{ id: TENANT_SLUG_O_ID }, { slug: TENANT_SLUG_O_ID }] } })
      : await prisma.organization.findFirst({ where: { brand: BRAND, name: { contains: "Sandbox" } } });
    if (!org) console.log("• No encontré la org sandbox (pasá TENANT_ORG_ID si tiene otro nombre).");
    else {
      await prisma.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED" } });
      console.log(`✔ Org ${org.name} (${org.slug}) → SUSPENDED.`);
    }
  }

  const sandboxUser = await prisma.user.findFirst({ where: { email: "sandbox.user@conversia.cl" }, select: { id: true } });
  if (sandboxUser) {
    console.log(
      "\n• Queda el usuario de TENANT `sandbox.user@conversia.cl` (panel del cliente, sin MFA).\n" +
        "  No es super admin, pero su contraseña también se publicó: cambiásela o desactivalo si el sandbox ya no se usa.",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
