import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { hashApiKey } from "./developers.controller";

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const createContactBody = z
  .object({
    phone: z.string().trim().min(6).max(32),
    firstName: z.string().trim().max(120).optional(),
    lastName: z.string().trim().max(120).optional(),
    email: z.string().trim().max(160).email().optional(),
    country: z.string().trim().max(2).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  })
  .strip();

/** Normaliza a E.164 conservando solo dígitos (mismo criterio que el resto). */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

/**
 * API PÚBLICA de Conversia (v1) — autenticación por API key del tenant
 * (Authorization: Bearer cnvk_…). El tenant sale de la key, jamás del cliente.
 * Scopes: contacts:read (GET) · contacts:write (POST).
 */
@Controller("public/v1")
export class PublicApiController {
  constructor(private prisma: PrismaService) {}

  /** Valida la API key, verifica el scope y devuelve la organización. */
  private async auth(req: Request, scope: string): Promise<{ organizationId: string; keyId: string }> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer cnvk_")) {
      throw new UnauthorizedException("Falta la API key (Authorization: Bearer cnvk_…)");
    }
    const secret = header.slice("Bearer ".length).trim();
    const key = await this.prisma.admin.apiKey.findUnique({ where: { hash: hashApiKey(secret) } });
    if (!key || key.revokedAt) throw new UnauthorizedException("API key inválida o revocada");
    const scopes = Array.isArray(key.scopes) ? (key.scopes as string[]) : [];
    if (!scopes.includes(scope)) throw new UnauthorizedException(`La API key no tiene el scope ${scope}`);
    // lastUsedAt best-effort (sin bloquear la petición)
    void this.prisma.admin.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { organizationId: key.organizationId, keyId: key.id };
  }

  @Get("contacts")
  async listContacts(@Req() req: Request, @Query() query: Record<string, string>) {
    const { organizationId } = await this.auth(req, "contacts:read");
    const q = listQuery.safeParse(query);
    if (!q.success) throw new BadRequestException(q.error.issues.map((i) => i.message).join("; "));
    const { q: term, page, pageSize } = q.data;
    return this.prisma.withTenant(organizationId, async (tx) => {
      const where = {
        deletedAt: null,
        ...(term
          ? {
              OR: [
                { firstName: { contains: term, mode: "insensitive" as const } },
                { lastName: { contains: term, mode: "insensitive" as const } },
                { phone: { contains: term } },
                { email: { contains: term, mode: "insensitive" as const } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.contact.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            country: true,
            createdAt: true,
            lastContactAt: true,
          },
        }),
        tx.contact.count({ where }),
      ]);
      return { items, total, page, pageSize };
    });
  }

  /** Crea (o completa) un contacto por teléfono — dedupe por E.164 del tenant. */
  @Post("contacts")
  async createContact(@Req() req: Request, @Body() body: unknown) {
    const { organizationId } = await this.auth(req, "contacts:write");
    const parsed = createContactBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    const input = parsed.data;
    const phone = normalizePhone(input.phone);
    if (!phone) throw new BadRequestException("Teléfono inválido");

    return this.prisma.withTenant(organizationId, async (tx) => {
      const existing = await tx.contact.findFirst({ where: { phone, deletedAt: null } });
      let contact;
      if (existing) {
        // Rellena SOLO campos vacíos (no pisa datos del equipo/bot)
        const data: Record<string, unknown> = {};
        if (input.firstName && !existing.firstName) data.firstName = input.firstName;
        if (input.lastName && !existing.lastName) data.lastName = input.lastName;
        if (input.email && !existing.email) data.email = input.email;
        if (input.country && !existing.country) data.country = input.country.toUpperCase();
        contact = Object.keys(data).length
          ? await tx.contact.update({ where: { id: existing.id }, data })
          : existing;
      } else {
        contact = await tx.contact.create({
          data: {
            organizationId,
            phone,
            firstName: input.firstName ?? null,
            lastName: input.lastName ?? null,
            email: input.email ?? null,
            country: input.country?.toUpperCase() ?? null,
            source: "api",
            createdVia: "api",
            acquisitionSource: "organic",
          },
        });
      }
      // Etiquetas opcionales (upsert por nombre)
      for (const raw of input.tags ?? []) {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId, name: raw } },
          update: {},
          create: { organizationId, name: raw },
          select: { id: true },
        });
        await tx.tagAssignment.createMany({
          data: [{ organizationId, tagId: tag.id, entityType: "contact", entityId: contact.id }],
          skipDuplicates: true,
        });
      }
      await tx.auditLog.create({
        data: { organizationId, actorType: "api", action: existing ? "contact.api_update" : "contact.api_create", entityType: "contact", entityId: contact.id },
      });
      return { id: contact.id, phone: contact.phone, created: !existing };
    });
  }
}
