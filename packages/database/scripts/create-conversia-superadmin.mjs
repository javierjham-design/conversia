#!/usr/bin/env node
/**
 * Crea (o resetea) el SUPER ADMIN de Conversia (D8): un PlatformAdmin con brand='conversia',
 * independiente del super admin de TuBot aunque compartan correo. SEGURO e idempotente:
 * solo toca la fila platform_admins de (email, 'conversia'); no toca tenants ni TuBot.
 *
 * Variables:
 *   SUPERADMIN_EMAIL     correo del super admin (requerido)
 *   SUPERADMIN_PASSWORD  contraseña inicial (requerido al crear)
 *   RESET_PASSWORD=1     si ya existe, le resetea la contraseña a SUPERADMIN_PASSWORD
 *   DATABASE_URL         conexión (usar DATABASE_PUBLIC_URL en Railway)
 *
 * Uso en prod (Railway):
 *   railway run --service Postgres -- bash -c 'cd packages/database && \
 *     DATABASE_URL="$DATABASE_PUBLIC_URL" SUPERADMIN_EMAIL="tu@correo" \
 *     SUPERADMIN_PASSWORD="…" node scripts/create-conversia-superadmin.mjs'
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const BRAND = "conversia";

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD ?? "";
  const reset = process.env.RESET_PASSWORD === "1";
  if (!email) throw new Error("Falta SUPERADMIN_EMAIL");

  const existing = await prisma.platformAdmin.findUnique({ where: { email_brand: { email, brand: BRAND } } });
  if (existing) {
    if (reset) {
      if (!password) throw new Error("RESET_PASSWORD=1 requiere SUPERADMIN_PASSWORD");
      await prisma.platformAdmin.update({ where: { id: existing.id }, data: { passwordHash: bcrypt.hashSync(password, 12) } });
      console.log(`✔ Super admin Conversia ${email}: contraseña reseteada. (MFA: ${existing.mfaEnabledAt ? "activo" : "pendiente de enrolar"})`);
    } else {
      console.log(`• Ya existe el super admin Conversia ${email} (id ${existing.id}). Usa RESET_PASSWORD=1 para cambiar la contraseña.`);
    }
    return;
  }

  if (!password) throw new Error("Falta SUPERADMIN_PASSWORD (para crear)");
  const created = await prisma.platformAdmin.create({
    data: { email, brand: BRAND, name: "Super Admin Conversia", passwordHash: bcrypt.hashSync(password, 12), role: "owner" },
  });
  console.log(`✔ Super admin Conversia creado: ${email} (id ${created.id}). Enrola MFA en el primer ingreso.`);
}

main()
  .catch((e) => {
    console.error("✖", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
