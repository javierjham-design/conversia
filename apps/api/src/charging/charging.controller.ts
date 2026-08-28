import { BadRequestException, Body, Controller, Get, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { encryptSecret, decryptSecret, maskSecret } from "../common/crypto";
import { flowTestCredentials, type FlowConfig } from "../billing/flow-subscriptions";
import { flowSign } from "../billing/payment-provider";

const FLOW_PROVIDER = "flow_charge"; // credencial Flow del TENANT para cobrar a SUS clientes
const FLOW_PROD = "https://www.flow.cl/api";
const FLOW_SANDBOX = "https://sandbox.flow.cl/api";

interface ChargingSettings {
  enabled?: boolean;
  sandbox?: boolean;
  notifyTeam?: boolean;
  instructions?: string;
}

/** Lee la config de cobros del tenant (settings) + si tiene credenciales cargadas. */
async function readCharging(prisma: PrismaService, orgId: string) {
  const [org, cred] = await Promise.all([
    prisma.admin.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
    prisma.admin.integrationCredential.findFirst({ where: { organizationId: orgId, provider: FLOW_PROVIDER } }),
  ]);
  const settings = ((org?.settings as Record<string, unknown> | null)?.charging as ChargingSettings) ?? {};
  let apiKeyMasked = "";
  if (cred) {
    try {
      const creds = JSON.parse(decryptSecret(cred.ciphertext)) as { apiKey: string };
      apiKeyMasked = maskSecret(creds.apiKey);
    } catch {
      /* credencial ilegible */
    }
  }
  return { settings, cred, apiKeyMasked };
}

/** Resuelve las credenciales Flow del tenant listas para firmar (o null si no hay). */
export async function resolveTenantFlow(prisma: PrismaService, orgId: string): Promise<FlowConfig | null> {
  const cred = await prisma.admin.integrationCredential.findFirst({ where: { organizationId: orgId, provider: FLOW_PROVIDER } });
  if (!cred) return null;
  const org = await prisma.admin.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const settings = ((org?.settings as Record<string, unknown> | null)?.charging as ChargingSettings) ?? {};
  try {
    const c = JSON.parse(decryptSecret(cred.ciphertext)) as { apiKey: string; secretKey: string };
    return { apiKey: c.apiKey, secretKey: c.secretKey, baseUrl: settings.sandbox ? FLOW_SANDBOX : FLOW_PROD };
  } catch {
    return null;
  }
}

/**
 * COBROS del tenant a SUS clientes vía Flow (cuenta Flow del propio tenant). El bot
 * genera links de pago con el monto acordado; este controlador administra la config
 * (credenciales cifradas + instrucciones + aviso al equipo) y valida las llaves.
 */
@Controller("charging")
export class ChargingController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async get() {
    const ctx = requireContext();
    const { settings, cred, apiKeyMasked } = await readCharging(this.prisma, ctx.organizationId);
    return {
      enabled: settings.enabled === true,
      sandbox: settings.sandbox === true,
      notifyTeam: settings.notifyTeam !== false, // por defecto avisa
      instructions: settings.instructions ?? "",
      hasCredentials: !!cred,
      apiKeyMasked,
    };
  }

  @Put()
  async save(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        sandbox: z.boolean().optional(),
        notifyTeam: z.boolean().optional(),
        instructions: z.string().max(2000).optional(),
        apiKey: z.string().trim().min(1).optional(),
        secretKey: z.string().trim().min(1).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos de cobro inválidos");
    const d = parsed.data;

    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    const prev = (org?.settings as Record<string, unknown> | null) ?? {};
    const prevCharging = (prev.charging as ChargingSettings) ?? {};
    const nextCharging: ChargingSettings = {
      enabled: d.enabled ?? prevCharging.enabled ?? false,
      sandbox: d.sandbox ?? prevCharging.sandbox ?? false,
      notifyTeam: d.notifyTeam ?? prevCharging.notifyTeam ?? true,
      instructions: d.instructions ?? prevCharging.instructions ?? "",
    };
    await this.prisma.admin.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...prev, charging: nextCharging } as object },
    });

    // Solo se guardan/actualizan las credenciales si vienen AMBAS (nunca se devuelven).
    if (d.apiKey && d.secretKey) {
      const ciphertext = encryptSecret(JSON.stringify({ apiKey: d.apiKey, secretKey: d.secretKey }));
      const existing = await this.prisma.admin.integrationCredential.findFirst({ where: { organizationId: ctx.organizationId, provider: FLOW_PROVIDER } });
      if (existing) {
        await this.prisma.admin.integrationCredential.update({ where: { id: existing.id }, data: { ciphertext, rotatedAt: new Date() } });
      } else {
        await this.prisma.admin.integrationCredential.create({ data: { organizationId: ctx.organizationId, provider: FLOW_PROVIDER, label: "Flow (cobros a clientes)", ciphertext } });
      }
    }
    return { ok: true };
  }

  @Post("test")
  async test() {
    const ctx = requireContext();
    const cfg = await resolveTenantFlow(this.prisma, ctx.organizationId);
    if (!cfg) throw new BadRequestException("Primero guarda tus credenciales de Flow");
    return flowTestCredentials(cfg);
  }
}

/**
 * Webhook PÚBLICO de confirmación de Flow para los cobros a clientes del tenant.
 * Flow llama con un `token`; NOSOTROS reconsultamos payment/getStatus (fuente firmada).
 * Idempotente por commerce_order/estado. Ruta bajo /webhooks/* (sin JWT de tenant).
 */
@Controller("webhooks")
export class ChargingWebhookController {
  constructor(private prisma: PrismaService) {}

  @Post("flow-charge")
  async confirm(@Req() req: Request, @Body() body: any) {
    const token = String(body?.token ?? (req.query?.token as string) ?? "").trim();
    if (!token) return { ok: false };
    const payment = await this.prisma.admin.customerPayment.findFirst({ where: { flowToken: token } });
    if (!payment) return { ok: false };
    if (payment.status === "paid") return { ok: true }; // ya procesado (idempotente)

    const cfg = await resolveTenantFlow(this.prisma, payment.organizationId);
    if (!cfg) return { ok: false };
    // getStatus firmado con las llaves del tenant (fuente de verdad).
    const params: Record<string, string> = { apiKey: cfg.apiKey, token };
    params.s = flowSign(params, cfg.secretKey);
    const res = await fetch(`${cfg.baseUrl}/payment/getStatus?${new URLSearchParams(params).toString()}`);
    const status: any = await res.json().catch(() => ({}));
    const paid = status?.status === 2 || status?.status === "2";
    const paidAmount = Number(status?.amount ?? 0);
    if (!paid) return { ok: true }; // pendiente/rechazado: no marcamos
    // Anti-fraude básico: el monto pagado debe cubrir lo esperado.
    if (paidAmount && paidAmount < payment.amount) return { ok: false };

    await this.prisma.admin.customerPayment.update({ where: { id: payment.id }, data: { status: "paid", paidAt: new Date() } });

    // Avisar al equipo (nota interna en la conversación) si está activado.
    const org = await this.prisma.admin.organization.findUnique({ where: { id: payment.organizationId }, select: { settings: true } });
    const charging = ((org?.settings as Record<string, unknown> | null)?.charging as ChargingSettings) ?? {};
    if (charging.notifyTeam !== false && payment.conversationId) {
      await this.prisma.admin.message.create({
        data: {
          organizationId: payment.organizationId,
          conversationId: payment.conversationId,
          direction: "OUTBOUND",
          type: "NOTE",
          visibility: "INTERNAL",
          body: `💰 Pago recibido: $${payment.amount.toLocaleString("es-CL")} — ${payment.subject}`,
          authorType: "SYSTEM",
          status: "DELIVERED",
        },
      });
    }
    return { ok: true };
  }
}

/** URL de confirmación que se pasa a Flow al crear el link (la usa el worker). */
export function chargeConfirmUrl(): string {
  return `${getEnv().API_URL}/webhooks/flow-charge`;
}
