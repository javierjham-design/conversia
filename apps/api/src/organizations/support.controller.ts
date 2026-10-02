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

type ThreadMsg = { author: "user" | "team" | "agent"; body: string; at: string };
/** Código legible del ticket (CV-XXXX), mismo estilo que los códigos de montaje. */
function newTicketCode(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `CV-${n}`;
}

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

    const firstMsg: ThreadMsg = { author: "user", body: parsed.data.message, at: new Date().toISOString() };
    const ticket = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.supportTicket.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId ?? null,
          email: user?.email ?? null,
          subject: parsed.data.subject || null,
          message: parsed.data.message,
          url: parsed.data.url || null,
          code: newTicketCode(),
          thread: [firstMsg] as object,
        },
      }),
    );

    void this.notify(ctx.organizationId, user, parsed.data).catch(() => undefined);
    return { ok: true, id: ticket.id, code: ticket.code };
  }

  /** Ticket ABIERTO del usuario (con su hilo) para el widget — retoma donde quedó. */
  @Get("active")
  async active() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const t = await tx.supportTicket.findFirst({
        where: { status: "open", ...(ctx.userId ? { userId: ctx.userId } : {}) },
        orderBy: { createdAt: "desc" },
        select: { id: true, code: true, subject: true, status: true, thread: true, createdAt: true },
      });
      return t ?? null;
    });
  }

  /** Crea o continúa el ticket abierto del usuario con un mensaje (persistencia server-side). */
  @Post("messages")
  async addMessage(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Mensaje requerido");
    const rl = await this.rateLimit.custom(`rl:supportmsg:${ctx.userId ?? "anon"}`, 30, 600);
    if (!rl.allowed) throw new HttpException("Demasiados mensajes seguidos. Espera un momento.", HttpStatus.TOO_MANY_REQUESTS);
    const user = ctx.userId ? await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true, name: true } }) : null;
    const now = new Date().toISOString();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const open = await tx.supportTicket.findFirst({ where: { status: "open", ...(ctx.userId ? { userId: ctx.userId } : {}) }, orderBy: { createdAt: "desc" } });
      if (open) {
        const thread = [...((open.thread as unknown as ThreadMsg[]) ?? []), { author: "user", body: parsed.data.body, at: now }];
        const t = await tx.supportTicket.update({ where: { id: open.id }, data: { thread: thread as object }, select: { id: true, code: true, status: true, thread: true } });
        return t;
      }
      const t = await tx.supportTicket.create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId ?? null,
          email: user?.email ?? null,
          message: parsed.data.body,
          code: newTicketCode(),
          thread: [{ author: "user", body: parsed.data.body, at: now }] as object,
        },
        select: { id: true, code: true, status: true, thread: true },
      });
      void this.notify(ctx.organizationId, user, { message: parsed.data.body }).catch(() => undefined);
      return t;
    });
  }

  /** Tickets propios del tenant (para mostrar historial en el widget). */
  @Get("mine")
  mine() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.supportTicket.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, code: true, subject: true, message: true, status: true, createdAt: true },
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
