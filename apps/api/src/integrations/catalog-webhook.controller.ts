import { Controller, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";

/**
 * Receptor PÚBLICO de webhooks de catálogo (/hooks/catalog/{token}) — TIEMPO REAL capa 1.
 * Cuando el cliente cambia un producto/precio/stock en su tienda (WooCommerce, Shopify,
 * Jumpseller, Bsale, Fudo), el proveedor golpea esta URL. El token único (guardado en la
 * conexión, no adivinable) resuelve la organización sin JWT. No confiamos en el cuerpo: solo
 * DISPARAMOS un sync incremental, con debounce por (org, fuente) para colapsar ráfagas
 * (un jobId fijo + delay: BullMQ ignora los duplicados mientras el trabajo espera). El motor
 * de sync (ya probado) trae los cambios reales. Complementa el tick programado cada 6h.
 */
@Controller("hooks/catalog")
export class CatalogWebhookController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  @Post(":token")
  @HttpCode(200)
  async receive(@Param("token") token: string) {
    if (!token || token.length < 16) throw new NotFoundException("Webhook no encontrado");
    // Cliente admin SOLO para el ruteo por token (endpoint público, sin contexto de tenant).
    const conn = await this.prisma.admin.integrationConnection.findFirst({
      where: { provider: { startsWith: "catalog_" }, config: { path: ["webhookToken"], equals: token } },
      select: { id: true, organizationId: true, provider: true },
    });
    if (!conn) throw new NotFoundException("Webhook no encontrado");
    const source = conn.provider.replace("catalog_", "");
    await this.queues.sync.add(
      "catalog",
      { organizationId: conn.organizationId, kind: "catalog_sync", payload: { source, mode: "incremental" } },
      { jobId: `catalog_webhook:${conn.organizationId}:${source}`, delay: 8000, removeOnComplete: true, removeOnFail: 500 },
    );
    return { received: true };
  }
}
