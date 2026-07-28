import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AgentsController } from "./agents/agents.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { ChannelsController } from "./channels/channels.controller";
import { WhatsappController } from "./channels/whatsapp.controller";
import { ConversationsController } from "./conversations/conversations.controller";
import { HealthController } from "./health.controller";
import { IntegrationsController } from "./integrations/integrations.controller";
import { MetaController } from "./integrations/meta.controller";
import { OrganizationsController } from "./organizations/organizations.controller";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queues";
import { BillingController } from "./billing/billing.controller";
import { RateLimitService } from "./common/rate-limit";
import { RateLimitMiddleware } from "./common/rate-limit.middleware";
import { PlatformAuthController } from "./platform/platform-auth.controller";
import { PlatformController } from "./platform/platform.controller";
import { PlatformGuard } from "./platform/platform.guard";
import { PlatformSessionService } from "./platform/platform-session.service";
import { PublicController } from "./public/public.controller";
import { ReportsController } from "./reports/reports.controller";
import { TenancyMiddleware } from "./tenancy/tenancy.middleware";
import { UsersController } from "./users/users.controller";
import { WorkflowsController } from "./workflows/workflows.controller";

@Module({
  controllers: [
    HealthController,
    AuthController,
    OrganizationsController,
    AgentsController,
    ConversationsController,
    ChannelsController,
    UsersController,
    IntegrationsController,
    MetaController,
    WorkflowsController,
    ReportsController,
    BillingController,
    WhatsappController,
    PublicController, // API pública de precios (sin auth)
    // Plataforma (super-admin) — autenticación y audiencia separadas
    PlatformAuthController,
    PlatformController,
  ],
  providers: [PrismaService, AuthService, QueueService, RateLimitService, TenancyMiddleware, RateLimitMiddleware, PlatformSessionService, PlatformGuard],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Orden: primero resuelve el tenant (JWT), luego aplica rate limit por usuario.
    // Las rutas /platform/* NO llevan tenant (son cross-tenant, con su propio
    // guard y auth); se excluyen del middleware de tenancy.
    consumer
      .apply(TenancyMiddleware, RateLimitMiddleware)
      .exclude("platform/(.*)", "platform")
      .forRoutes("*");
  }
}
