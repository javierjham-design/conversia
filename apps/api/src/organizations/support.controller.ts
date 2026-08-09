import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { RateLimitService } from "../common/rate-limit";
import { sendEmail } from "../common/email";
import { requireContext } from "../tenancy/context";

const ticketSchema = z.object({
  subject: z.string().trim().max(120).optional(),
  message: z.string().trim().min(5, "Cuéntanos un poco más").max(4000),
  url: z.string().trim().max(300).optional(),
});

/**
 * Soporte in-app: el cliente reporta un problema desde el panel y queda visible
 * para el Super Admin (bandeja + correo), sin depender de que escriba por WhatsApp.
 */
@Controller("support")
export class SupportController {
  constructor(
    private prisma: PrismaService,
    private rateLimit: RateLimitService,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request) {
    const ctx = requireContext();
    const parsed = ticketSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));

    // Anti-spam: máx. 5 tickets cada 10 min por usuario.
    const rl = await this.rateLimit.custom(`rl:support:${ctx.userId ?? "anon"}`, 5, 600);
    if (!rl.allowed) throw new HttpException("Demasiados reportes seguidos. Espera unos minutos.", HttpStatus.TOO_MANY_REQUESTS);

    const user = ctx.userId
      ? await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true, name: true } })
      : null;

    const ticket = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.supportTicket.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId ?? null,
          email: user?.email ?? null,
          subject: parsed.data.subject || null,
          message: parsed.data.message,
          url: parsed.data.url || null,
        },
      }),
    );

    void this.notify(ctx.organizationId, user, parsed.data).catch(() => undefined);
    return { ok: true, id: ticket.id };
  }

  /** Tickets propios del tenant (para mostrar historial en el widget). */
  @Get("mine")
  mine() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.supportTicket.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, subject: true, message: true, status: true, createdAt: true },
      }),
    );
  }

  /** Aviso por correo al equipo (si hay destinatario + Resend configurados). */
  private async notify(orgId: string, user: { email: string; name: string } | null, data: z.infer<typeof ticketSchema>) {
    const to = getEnv().SUPPORT_NOTIFY_EMAIL;
    if (!to) return;
    const org = await this.prisma.admin.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    await sendEmail({
      to,
      subject: `🆘 Soporte — ${org?.name ?? "tenant"}${data.subject ? `: ${data.subject}` : ""}`,
      replyTo: user?.email,
      html: `<p><b>Organización:</b> ${escapeHtml(org?.name ?? orgId)}</p>
<p><b>De:</b> ${escapeHtml(user?.name ?? "—")} (${escapeHtml(user?.email ?? "sin correo")})</p>
${data.url ? `<p><b>Página:</b> ${escapeHtml(data.url)}</p>` : ""}
<hr/><p style="white-space:pre-wrap">${escapeHtml(data.message)}</p>`,
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
