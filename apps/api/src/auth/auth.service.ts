import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as bcryptMod from "bcryptjs";
import { DEFAULT_LEAD_STATUSES, DEFAULT_ROLES } from "@conversia/types";
import { brandOf, accentForCountry } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { VerticalService } from "../organizations/vertical.service";
import { applyDraftToOrganization, type ApplyDraftTx } from "./apply-draft";
import { signAppToken, signMfaToken, signEmailVerifyToken, verifyEmailVerifyToken } from "./jwt";
import { RefreshSessionService } from "./refresh-session.service";
import { sendEmail } from "../common/email";
import { encryptSecret, decryptSecret } from "../common/crypto";
import { consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp } from "./totp";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;
/** Costo bcrypt (ASVS 2.4): 12 es el mínimo recomendado actual. */
export const BCRYPT_COST = 12;

/** Días de prueba de TuBot y días hasta la purga (7 + 7). No se tocan. */
export const TRIAL_DAYS = 7;
export const TRIAL_PURGE_DAYS = 14;

export interface TrialWindow {
  startedAt: string;
  endsAt: string;
  purgeAt: string;
  state: "active";
  warnedDays: number[];
}

/**
 * §6.10 — Ventana de prueba de una cuenta nueva, SEGÚN SU MARCA.
 *
 * TuBot: 7 días de prueba y purga a los 14 (el "7+7" de siempre). Conversia NO usa el
 * trial de autoservicio: la cuenta nace "pendiente de implementación", sin countdown ni
 * purga, y el ciclo de cobro arranca al ENTREGAR (B6/F5).
 *
 * Está extraída de `register` para poder fijarla con un test sin levantar la base: es una
 * de las cosas que la etapa 6 promete no haberle cambiado a TuBot.
 */
export function trialWindowFor(brand: string | null | undefined, now: Date): TrialWindow | null {
  if ((brand ?? "tubot") === "conversia") return null;
  return {
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString(),
    purgeAt: new Date(now.getTime() + TRIAL_PURGE_DAYS * 86_400_000).toISOString(),
    state: "active",
    warnedDays: [],
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private vertical: VerticalService,
    private refreshSessions: RefreshSessionService,
  ) {}

  /**
   * V2-9 — ¿está encendido el autoservicio V2 para la marca? Lee el platformSetting
   * `selfServeV2` (lo enciende scripts/v2-golive.mjs con OK del dueño). OFF por defecto:
   * ante cualquier duda (setting ausente/ilegible) devuelve false → comportamiento previo.
   */
  async selfServeV2Enabled(brand: string): Promise<boolean> {
    try {
      const row = await this.prisma.admin.platformSetting.findUnique({ where: { key: "selfServeV2" } });
      if (!row) return false;
      const val = JSON.parse(row.value) as Record<string, boolean>;
      return val[brand.toLowerCase()] === true;
    } catch {
      return false;
    }
  }

  /**
   * Registro self-service: crea usuario + organización + roles del sistema +
   * estados de lead por defecto. Corre con la conexión admin (crear una
   * organización es una operación de plataforma, fuera del RLS del tenant).
   */
  async register(input: { email: string; password: string; name: string; organizationName: string; brand?: string; country?: string; vertical?: string; draftToken?: string }) {
    const db = this.prisma.admin;
    const brand = input.brand ?? "tubot";
    // V2-3 — si viene draftToken, cargamos el draft del generador /crear para materializarlo
    // (su rubro manda si no vino `vertical`; al final se acreditan 30 conversaciones + se destruye).
    const draft = input.draftToken
      ? await db.draftSession.findUnique({ where: { token: input.draftToken } }).catch(() => null)
      : null;
    const draftValid = draft && draft.status === "draft" && draft.expiresAt > new Date();
    const effectiveVertical = input.vertical ?? (draftValid ? draft!.vertical : undefined);
    // Cuentas POR MARCA (D8): el mismo correo puede existir en otra marca; se valida la
    // unicidad SOLO dentro de esta marca.
    const existing = await db.user.findUnique({ where: { email_brand: { email: input.email, brand } } });
    // Anti-enumeración (ASVS 2.2 / OWASP): mensaje genérico + rate limit en el
    // controlador. No confirmamos si el correo ya existe.
    if (existing) throw new ConflictException("No se pudo completar el registro con esos datos");

    let slug = slugify(input.organizationName) || "organizacion";
    if (await db.organization.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }

    // La PRUEBA de 7 días queda fijada DESDE el registro (no espera el tick del
    // worker): el banner de días restantes y el corte del día 7 valen desde ya.
    // B6/F5 — Conversia NO usa el trial autoservicio: la cuenta NACE "pendiente de
    // implementación" (sin countdown ni purga) y el ciclo de cobro arranca al ENTREGAR.
    const isConversia = brand === "conversia";
    const now = new Date();
    const trial = trialWindowFor(brand, now);
    const endsAt = trial?.endsAt ?? new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString();

    // La cuenta nace ASIGNADA al plan Free (no "sin plan / todo en 0"): se crea una
    // suscripción TRIALING al plan gratuito para que la plataforma quede OPERATIVA
    // (los límites del plan Free aplican y el asistente de montaje puede trabajar) y
    // el plan se vea asignado en billing. `validUntil` = fin de la prueba: la
    // "Vigencia del servicio" queda visible y el corte del día 7 se hace cumplir por
    // vigencia además del ciclo de prueba (ambos apuntan al mismo día → sin conflicto).
    const freePlan = await db.plan.findUnique({ where: { code: "free" } });

    // V2-9 — switch de autoservicio por conversación (OFF por defecto; lo enciende
    // scripts/v2-golive.mjs con OK del dueño). Con el switch ON (o si el registro viene
    // del generador /crear, que ya es flujo V2) la cuenta conversia NACE en modo V2:
    // plan de PRUEBA (debita de la bolsa, incluye 0) + 30 conversaciones gratis sin
    // tarjeta. TuBot y los planes conversia V1 (grandfathered) no se tocan.
    const selfServeV2On = isConversia && (await this.selfServeV2Enabled("conversia"));
    const v2Mode = isConversia && (selfServeV2On || !!draftValid);
    const v2TrialPlan = v2Mode ? await db.plan.findUnique({ where: { code: "conversia_v2_trial" } }) : null;

    const result = await db.$transaction(async (tx) => {
      // Marca derivada server-side (nunca del body); país del registro → moneda (CL=CLP,
      // resto=USD, misma estrategia que facturación). Default: tubot/CL/CLP = como hoy.
      const country = (input.country ?? "CL").toUpperCase();
      const currency = country === "CL" ? "CLP" : "USD";
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          slug,
          brand: input.brand ?? "tubot",
          country,
          currency,
          // V2: plan de prueba por conversación. V1 conversia: Free (pendiente). TuBot: Free.
          planId: (v2Mode ? v2TrialPlan?.id : freePlan?.id) ?? freePlan?.id ?? null,
          // V2: lifecycle "v2_trial" (30 gratis, el ciclo arranca al activar/pagar).
          // V1 conversia: pendiente de implementación. TuBot: prueba 7 días + vigencia.
          settings: (v2Mode
            ? { conversia: { lifecycle: "v2_trial", accent: accentForCountry(country) } }
            : isConversia
              ? { conversia: { lifecycle: "pending" } }
              : { trial, validUntil: endsAt }) as object,
        },
      });
      // Habilita las políticas RLS para los inserts hijos de esta transacción.
      // (El INSERT en organizations requiere rol admin — ver docs/MULTITENANCY.md.)
      await tx.$queryRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
      // TuBot nace TRIALING (prueba). Conversia V1 NO crea suscripción al registrarse: el
      // ciclo arranca al marcar ENTREGADO (markDelivered). Conversia V2 nace TRIALING al
      // plan de PRUEBA (debita de la bolsa para que las 30 gratis cuenten; incluye 0 → no
      // acredita créditos de plan). Al activar/pagar, la suscripción pasa a conversia_v2_base.
      if (v2Mode && v2TrialPlan) {
        await tx.subscription.create({
          data: {
            organizationId: org.id,
            planId: v2TrialPlan.id,
            status: "TRIALING",
            interval: "monthly",
            periodStart: now,
            periodEnd: new Date(now.getTime() + 60 * 86_400_000),
          },
        });
      } else if (freePlan && !isConversia) {
        await tx.subscription.create({
          data: {
            organizationId: org.id,
            planId: freePlan.id,
            status: "TRIALING",
            interval: "monthly",
            periodStart: now,
            periodEnd: new Date(endsAt),
          },
        });
      }
      // V2-9 — evento de funnel: registro (etapa 1). Best-effort, dentro de la tx con RLS.
      if (v2Mode) {
        await tx.integrationEvent
          .create({ data: { organizationId: org.id, provider: "funnel", type: "registered", payload: { vertical: effectiveVertical ?? null, fromDraft: !!draftValid } as object } })
          .catch(() => undefined);
      }
      const roles = await Promise.all(
        DEFAULT_ROLES.map((r) =>
          tx.role.create({
            data: {
              organizationId: org.id,
              code: r.code,
              name: r.name,
              permissions: [...r.permissions],
              system: true,
            },
          }),
        ),
      );
      const ownerRole = roles.find((r) => r.code === "owner")!;
      const user = await tx.user.create({
        data: {
          email: input.email,
          brand, // cuenta de ESTA marca (D8)
          passwordHash: bcrypt.hashSync(input.password, BCRYPT_COST),
          name: input.name,
          // F3/A13 — acento de UI por defecto según el país (solo Conversia; el usuario
          // puede cambiarlo luego vía PATCH /me/preferences). TuBot no usa acento.
          ...(brand === "conversia" ? { settings: { accent: accentForCountry(country) } as object } : {}),
        },
      });
      await tx.organizationUser.create({
        data: { organizationId: org.id, userId: user.id, roleId: ownerRole.id },
      });
      await tx.leadStatus.createMany({
        data: DEFAULT_LEAD_STATUSES.map((s) => ({
          organizationId: org.id,
          code: s.code,
          name: s.name,
          emoji: s.emoji,
          category: s.category as any,
          order: s.order,
          system: true,
        })),
      });
      await tx.auditLog.create({
        data: {
          organizationId: org.id,
          actorType: "user",
          actorId: user.id,
          action: "organization.create",
          entityType: "organization",
          entityId: org.id,
        },
      });
      return { org, user, role: ownerRole };
    });

    // Paquete vertical (F2): si el registro trae rubro y hay plantilla activa, se
    // instala tras crear la org (post-commit; tiene su propia transacción con RLS).
    // Best-effort: si falla, el usuario queda creado y puede instalarlo desde onboarding.
    // SOLO marca conversia (auditoría frontera de marcas 17-oct-2026): el endpoint es
    // público y un register TuBot con `vertical` en el body inyectaba contenido de
    // plantillas Conversia (servicios/agentes/etapas) en una org TuBot.
    if (effectiveVertical && isConversia) {
      try {
        await this.vertical.install(result.org.id, effectiveVertical, { source: "registration" });
      } catch (e) {
        console.error(`✖ No se pudo instalar el paquete vertical "${effectiveVertical}" en ${result.org.id}:`, (e as Error).message);
      }
    }

    // COP Etapa 0 — aplicar lo que el cliente ya cargó en `/crear` (hallazgo 5): web y
    // texto leído de su sitio quedan en la organización, y ese texto se ANEXA al prompt de
    // los agentes que acaba de instalar el paquete del rubro. Sin esto, el cliente prueba
    // un bot que habla de SU negocio y al registrarse recibe uno genérico.
    // Va DESPUÉS del vertical a propósito (anexa sobre lo que el paquete dejó) y es
    // best-effort: si falla, la cuenta queda igual de usable.
    if (draftValid && isConversia) {
      try {
        await this.prisma.withTenant(result.org.id, (tx) =>
          applyDraftToOrganization(tx as unknown as ApplyDraftTx, result.org.id, {
            businessName: draft!.businessName,
            website: draft!.website,
            config: draft!.config,
          }),
        );
      } catch (e) {
        console.error(`✖ No se pudo aplicar el borrador de /crear en ${result.org.id}:`, (e as Error).message);
      }
    }

    // V2-3/V2-9 — 30 conversaciones de regalo (sin tarjeta) a TODA cuenta conversia en
    // modo V2 (venga o no del generador /crear). El plan de prueba debita de la bolsa, así
    // que estas 30 cuentan de verdad. Si vino de un draft, además se marca materializado.
    if (v2Mode) {
      try {
        const expiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000); // regalo: 60 días
        const refId = draftValid ? draft!.token : `signup:${result.org.id}`;
        await this.prisma.withTenant(result.org.id, async (tx) => {
          // periodStart = época: la wallet nace "nunca acreditada" para que el PRIMER período
          // del plan acredite sus créditos (el default now() del schema marcaba el período
          // actual como ya acreditado y el primer lote del plan jamás se creaba).
          await tx.conversationWallet.upsert({ where: { organizationId: result.org.id }, create: { organizationId: result.org.id, periodStart: new Date(0) }, update: {} });
          // Idempotente por refId (no duplica el regalo si se reintenta).
          const dup = await tx.conversationCreditLedger.findFirst({ where: { organizationId: result.org.id, refType: "signup_gift", refId }, select: { id: true } });
          if (!dup) {
            await tx.conversationCreditLot.create({ data: { organizationId: result.org.id, source: "bonus", amount: 30, remaining: 30, expiresAt, refType: "signup_gift", refId } });
            await tx.conversationCreditLedger.create({ data: { organizationId: result.org.id, delta: 30, reason: "admin_adjust", balanceAfter: 30, refType: "signup_gift", refId } });
          }
        });
        if (draftValid) await db.draftSession.update({ where: { id: draft!.id }, data: { status: "materialized", materializedOrgId: result.org.id } });
      } catch (e) {
        console.error(`✖ No se pudieron acreditar las 30 conversaciones de regalo en ${result.org.id}:`, (e as Error).message);
      }
    }

    // Verificación de correo (D6): solo marca conversia envía el link al registrarse.
    // Best-effort: si el correo no sale, la cuenta igual queda creada (verificación blanda).
    if (brand === "conversia") {
      await this.sendVerificationEmail(result.user.id, input.email, result.org).catch(() => {});
    }

    return this.issueTokens(result.user.id, result.org.id, result.role.code, ["*"]);
  }

  /** Envía (o reenvía) el correo de verificación con un link de 2 días. Best-effort. */
  async sendVerificationEmail(userId: string, email: string, org: { brand?: string | null } | null): Promise<boolean> {
    const token = signEmailVerifyToken(userId);
    const brand = brandOf(org);
    const link = `${brand.webUrl}/verify?token=${encodeURIComponent(token)}`;
    const html = `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px">
<h2 style="margin:0 0 12px">Confirma tu correo</h2>
<p>¡Bienvenido a ${brand.name}! Confirma tu correo para asegurar tu cuenta.</p>
<p style="margin:22px 0"><a href="${link}" style="background:#0f9e8e;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Confirmar mi correo</a></p>
<p style="color:#64748b;font-size:13px">O copia este enlace: <br/>${link}</p>
<p style="color:#64748b;font-size:13px">El enlace vence en 2 días. Si no creaste esta cuenta, ignora este mensaje.</p>
</div>`;
    return sendEmail({ to: email, subject: `Confirma tu correo · ${brand.name}`, html, from: brand.mailFrom, replyTo: brand.replyTo ?? undefined, apiKey: brand.resendApiKey });
  }

  /** Marca el correo del usuario como verificado a partir del token del link. */
  async verifyEmail(token: string): Promise<{ ok: true }> {
    let sub: string;
    try {
      ({ sub } = verifyEmailVerifyToken(token));
    } catch {
      throw new BadRequestException("El enlace no es válido o venció. Pide uno nuevo.");
    }
    await this.prisma.admin.user.update({ where: { id: sub }, data: { emailVerifiedAt: new Date() } });
    return { ok: true };
  }

  /** Reenvía el correo de verificación al usuario actual (si aún no está verificado). */
  async resendVerification(userId: string): Promise<{ sent: boolean; alreadyVerified: boolean }> {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
    if (!user) throw new BadRequestException("Usuario no encontrado");
    if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    // La marca sale de alguna org del usuario (por el Origin ya se resolvió su cuenta).
    const membership = await this.prisma.admin.organizationUser.findFirst({ where: { userId }, select: { organizationId: true } });
    const org = membership ? await this.prisma.admin.organization.findUnique({ where: { id: membership.organizationId }, select: { brand: true } }) : null;
    const sent = await this.sendVerificationEmail(userId, user.email, org);
    return { sent, alreadyVerified: false };
  }

  /**
   * Provisiona un DEMO: organización + usuario owner con IA PAUSADA
   * (aiKillSwitch) para que NO gaste tokens hasta que el super admin la habilite,
   * con vigencia limitada. Devuelve las credenciales (contraseña temporal una vez).
   */
  async provisionDemo(input: { email: string; name: string; company: string; demoDays?: number }) {
    const db = this.prisma.admin;
    let slug = slugify(input.company) || "demo";
    if (await db.organization.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const validUntil = new Date(Date.now() + (input.demoDays ?? 14) * 24 * 3600 * 1000).toISOString();
    const tempPassword = randomBytes(6).toString("base64url");
    return db.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.company,
          slug,
          // Demo: IA pausada (no gasta tokens) + tope 0 + vigencia, hasta habilitar.
          settings: { demo: true, aiKillSwitch: true, validUntil, limits: { aiTokensDaily: 0 } },
        },
      });
      await tx.$queryRaw`SELECT set_config('app.org_id', ${org.id}, true)`;
      const roles = await Promise.all(
        DEFAULT_ROLES.map((r) =>
          tx.role.create({ data: { organizationId: org.id, code: r.code, name: r.name, permissions: [...r.permissions], system: true } }),
        ),
      );
      const ownerRole = roles.find((r) => r.code === "owner")!;
      // Demo del Super Admin TuBot: la cuenta demo es de marca tubot (D8).
      let user = await tx.user.findUnique({ where: { email_brand: { email: input.email, brand: "tubot" } } });
      let revealPassword: string | null = tempPassword;
      if (!user) {
        user = await tx.user.create({
          data: { email: input.email, brand: "tubot", passwordHash: bcrypt.hashSync(tempPassword, BCRYPT_COST), name: input.name },
        });
      } else {
        revealPassword = null; // ya tenía cuenta: usa su contraseña existente
      }
      await tx.organizationUser.create({ data: { organizationId: org.id, userId: user.id, roleId: ownerRole.id } });
      await tx.leadStatus.createMany({
        data: DEFAULT_LEAD_STATUSES.map((s) => ({ organizationId: org.id, code: s.code, name: s.name, emoji: s.emoji, category: s.category as any, order: s.order, system: true })),
      });
      return { organizationId: org.id, email: input.email, tempPassword: revealPassword, validUntil };
    });
  }

  /** Usuario administrador (owner, o primer miembro activo) de una organización. */
  private async orgAdminUser(orgId: string) {
    const memberships = await this.prisma.admin.organizationUser.findMany({
      where: { organizationId: orgId, active: true },
      include: { user: true },
    });
    if (!memberships.length) return null;
    const roles = await this.prisma.admin.role.findMany({ where: { organizationId: orgId } });
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const chosen = memberships.find((m) => roleById.get(m.roleId)?.code === "owner") ?? memberships[0];
    return chosen.user;
  }

  /** Restablece la contraseña del admin del tenant: genera una temporal y actualiza el hash. */
  async resetOrgAdminPassword(orgId: string): Promise<{ userId: string; email: string; tempPassword: string } | null> {
    const user = await this.orgAdminUser(orgId);
    if (!user) return null;
    const tempPassword = randomBytes(6).toString("base64url");
    await this.prisma.admin.user.update({ where: { id: user.id }, data: { passwordHash: bcrypt.hashSync(tempPassword, BCRYPT_COST) } });
    return { userId: user.id, email: user.email, tempPassword };
  }

  /** Cambia el correo del admin del tenant (valida unicidad global). */
  async setOrgAdminEmail(orgId: string, email: string): Promise<{ userId: string; email: string }> {
    const user = await this.orgAdminUser(orgId);
    if (!user) throw new BadRequestException("La organización no tiene usuarios activos");
    // Unicidad DENTRO de la marca del usuario (D8): el mismo correo puede existir en otra marca.
    const existing = await this.prisma.admin.user.findFirst({ where: { email, brand: user.brand } });
    if (existing && existing.id !== user.id) throw new ConflictException("Ese correo ya está en uso");
    await this.prisma.admin.user.update({ where: { id: user.id }, data: { email } });
    return { userId: user.id, email };
  }

  async login(input: { email: string; password: string; brand?: string }) {
    // Cuentas POR MARCA (D8): el correo se resuelve dentro de su marca (la del dominio
    // de origen). El mismo email en TuBot y Conversia son cuentas distintas.
    const brand = input.brand ?? "tubot";
    const user = await this.prisma.admin.user.findUnique({
      where: { email_brand: { email: input.email, brand } },
      include: { memberships: { where: { active: true } } },
    });
    if (!user || !bcrypt.compareSync(input.password, user.passwordHash)) {
      throw new UnauthorizedException("Credenciales inválidas");
    }
    const membership = user.memberships[0];
    if (!membership) throw new UnauthorizedException("El usuario no pertenece a ninguna organización");

    // 2.º factor activo → desafío (no se emite sesión hasta verificar el código).
    if (user.mfaEnabled) {
      return { mfaRequired: true as const, mfaToken: signMfaToken(user.id, "verify") };
    }
    // La organización exige MFA a owner/admin y este no está enrolado → forzar enrolamiento.
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const roleCode = role?.code ?? "viewer";
    const org = await this.prisma.admin.organization.findUnique({ where: { id: membership.organizationId }, select: { settings: true } });
    if ((org?.settings as any)?.security?.requireMfaForAdmins === true && (roleCode === "owner" || roleCode === "admin")) {
      return { mfaSetupRequired: true as const, mfaToken: signMfaToken(user.id, "setup") };
    }
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, roleCode, perms);
  }

  /** Emite la sesión completa de un usuario ya validado (2.º factor o Google). */
  private async issueForUser(userId: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId }, include: { memberships: { where: { active: true } } } });
    const membership = user?.memberships[0];
    if (!user || !membership) throw new UnauthorizedException("Sesión inválida");
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
  }

  /** Verifica el 2.º factor (TOTP o código de recuperación) y emite la sesión. */
  async verifyMfaLogin(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled || !user.mfaSecret) throw new UnauthorizedException("MFA no está activo");
    if (verifyTotp(decryptSecret(user.mfaSecret), code)) return this.issueForUser(userId);
    const remaining = consumeRecoveryCode(code, Array.isArray(user.mfaRecoveryCodes) ? (user.mfaRecoveryCodes as string[]) : []);
    if (remaining) {
      await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: remaining } });
      return this.issueForUser(userId);
    }
    throw new UnauthorizedException("Código de verificación inválido");
  }

  /** Genera un secreto TOTP (aún NO activo) y devuelve el URI para el QR. */
  async beginMfaSetup(userId: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("Usuario inválido");
    const secret = generateTotpSecret();
    await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaSecret: encryptSecret(secret) } });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** Confirma el código y ACTIVA MFA; devuelve los códigos de recuperación (una vez) + sesión. */
  async enableMfa(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaSecret) throw new BadRequestException("Primero genera el código QR de configuración.");
    if (!verifyTotp(decryptSecret(user.mfaSecret), code)) throw new BadRequestException("El código no es correcto. Revisa la hora de tu teléfono e inténtalo de nuevo.");
    const recoveryCodes = generateRecoveryCodes(8);
    await this.prisma.admin.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
    });
    const session = await this.issueForUser(userId);
    return { recoveryCodes, ...session };
  }

  /** Desactiva MFA tras validar un código (TOTP o de recuperación). */
  async disableMfa(userId: string, code: string) {
    const user = await this.prisma.admin.user.findUnique({ where: { id: userId } });
    if (!user?.mfaEnabled) return { ok: true };
    const totpOk = user.mfaSecret ? verifyTotp(decryptSecret(user.mfaSecret), code) : false;
    const recoveryOk = consumeRecoveryCode(code, Array.isArray(user.mfaRecoveryCodes) ? (user.mfaRecoveryCodes as string[]) : []) !== null;
    if (!totpOk && !recoveryOk) throw new BadRequestException("Código incorrecto.");
    await this.prisma.admin.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null } });
    return { ok: true };
  }

  /**
   * Login con Google: el email ya viene verificado (ID token validado con Google
   * en el controlador). Solo permitimos cuentas que YA existen como miembros —
   * no es auto-registro. Mensaje genérico para no filtrar qué correos existen.
   */
  async loginWithGoogle(email: string, brand = "tubot") {
    const user = await this.prisma.admin.user.findUnique({
      where: { email_brand: { email, brand } },
      include: { memberships: { where: { active: true } } },
    });
    const membership = user?.memberships[0];
    if (!user || !membership) {
      throw new UnauthorizedException("Tu cuenta de Google no está autorizada en la plataforma");
    }
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role!.permissions as string[]) : [];
    await this.touchLastLogin(user.id);
    return this.issueTokens(user.id, membership.organizationId, role?.code ?? "viewer", perms);
  }

  /** Organizaciones a las que pertenece el usuario (para el selector de tenant). */
  async listOrganizations(userId: string) {
    const memberships = await this.prisma.admin.organizationUser.findMany({ where: { userId, active: true } });
    if (!memberships.length) return [];
    const [orgs, roles] = await Promise.all([
      this.prisma.admin.organization.findMany({ where: { id: { in: memberships.map((m) => m.organizationId) }, deletedAt: null }, select: { id: true, name: true, slug: true, status: true } }),
      this.prisma.admin.role.findMany({ where: { id: { in: memberships.map((m) => m.roleId) } }, select: { id: true, code: true } }),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const roleById = new Map(roles.map((r) => [r.id, r.code]));
    return memberships
      .map((m) => {
        const org = orgById.get(m.organizationId);
        return org ? { id: org.id, name: org.name, slug: org.slug, status: org.status, roleCode: roleById.get(m.roleId) ?? "viewer" } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Cambia la organización activa: valida la membresía y emite un token nuevo. */
  async switchOrg(userId: string, organizationId: string) {
    const membership = await this.prisma.admin.organizationUser.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!membership || !membership.active) throw new UnauthorizedException("No perteneces a esa organización");
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { deletedAt: true } });
    if (!org || org.deletedAt) throw new UnauthorizedException("Organización no disponible");
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    return this.issueTokens(userId, organizationId, role?.code ?? "viewer", perms);
  }

  /** Marca la última conexión — best-effort, jamás bloquea el login. */
  private async touchLastLogin(userId: string) {
    try {
      await this.prisma.admin.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    } catch {
      /* ignore */
    }
  }

  private async issueTokens(userId: string, orgId: string, roleCode: string, perms: string[]) {
    const token = signAppToken({ sub: userId, orgId, role: roleCode, perms });
    // Sesión deslizante (Bloque 3): junto al access token corto emitimos un refresh token opaco de
    // larga vida. Aditivo — quien no lo use (p. ej. el panel de TuBot) simplemente lo ignora.
    const refreshToken = await this.refreshSessions.create(userId, orgId);
    return { token, refreshToken, organizationId: orgId, role: roleCode };
  }

  /**
   * Bloque 3 — renueva la sesión a partir de un refresh token válido: valida que siga vivo en
   * Redis, RE-RESUELVE la membresía (si fue revocada, 401), emite un access token nuevo y ROTA el
   * refresh (revoca el usado, entrega uno nuevo). Cada uso corre 30 d la ventana. 401 = re-login.
   */
  async refresh(refreshToken: string) {
    const session = await this.refreshSessions.resolve(refreshToken);
    if (!session) throw new UnauthorizedException("Sesión expirada o revocada");
    const membership = await this.prisma.admin.organizationUser.findUnique({
      where: { organizationId_userId: { organizationId: session.orgId, userId: session.userId } },
    });
    if (!membership || !membership.active) {
      await this.refreshSessions.revoke(refreshToken); // la membresía ya no existe → el refresh no sirve
      throw new UnauthorizedException("La sesión ya no es válida");
    }
    const role = await this.prisma.admin.role.findUnique({ where: { id: membership.roleId } });
    const perms = Array.isArray(role?.permissions) ? (role.permissions as string[]) : [];
    const token = signAppToken({ sub: session.userId, orgId: session.orgId, role: role?.code ?? "viewer", perms });
    // Rotación: el token usado deja de valer y entregamos uno nuevo (anti-replay).
    await this.refreshSessions.revoke(refreshToken);
    const nextRefresh = await this.refreshSessions.create(session.userId, session.orgId);
    return { token, refreshToken: nextRefresh, organizationId: session.orgId, role: role?.code ?? "viewer" };
  }

  /** Bloque 2 — cierra la sesión revocando el refresh token (best-effort; el logout del cliente igual sale). */
  async logout(refreshToken?: string) {
    if (refreshToken) await this.refreshSessions.revoke(refreshToken);
    return { ok: true as const };
  }

  /** Revoca TODAS las sesiones deslizantes del usuario (p. ej. tras cambiar la contraseña). Best-effort. */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshSessions.revokeAllForUser(userId);
  }
}
