import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AgentsController } from "./agents/agents.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { ChannelsController } from "./channels/channels.controller";
import { WhatsappController } from "./channels/whatsapp.controller";
import { ContactsController } from "./contacts/contacts.controller";
import { LifecycleController } from "./contacts/lifecycle.controller";
import { ConversationsController } from "./conversations/conversations.controller";
import { InboxController } from "./conversations/inbox.controller";
import { RealtimeService } from "./common/realtime.service";
import { HealthController } from "./health.controller";
import { DevelopersController } from "./integrations/developers.controller";
import { InboundHookController } from "./integrations/inbound-hook.controller";
import { IntegrationsController } from "./integrations/integrations.controller";
import { MetaController } from "./integrations/meta.controller";
import { OAuthController } from "./integrations/oauth.controller";
import { PublicApiController } from "./integrations/public-api.controller";
import { OrganizationsController } from "./organizations/organizations.controller";
import { SettingsController } from "./organizations/settings.controller";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queues";
import { BillingController } from "./billing/billing.controller";
import { PaymentSettingsService } from "./billing/payment-settings.service";
import { RateLimitService } from "./common/rate-limit";
import { RateLimitMiddleware } from "./common/rate-limit.middleware";
import { PlatformAuthController } from "./platform/platform-auth.controller";
import { PlatformController } from "./platform/platform.controller";
import { PlatformGuard } from "./platform/platform.guard";
import { PlatformSessionService } from "./platform/platform-session.service";
import { PublicController } from "./public/public.controller";
import { ReportsController } from "./reports/reports.controller";
import { ClarivaWebhookController } from "./scheduling/clariva-webhook.controller";
import { TenancyMiddleware } from "./tenancy/tenancy.middleware";
import { UsersController } from "./users/users.controller";
import { WorkflowsController } from "./workflows/workflows.controller";

@Module({
  controllers: [
    HealthController,
    AuthController,
    OrganizationsController,
    SettingsController, // Centro de Configuración del tenant (/settings)
    AgentsController,
    ConversationsController,
    InboxController, // clasificador de la Bandeja: conteos, bandejas, snippets, asistente IA
    ContactsController,
    LifecycleController, // etapas del ciclo de vida editables por tenant
    ChannelsController,
    UsersController,
    IntegrationsController,
    MetaController,
    OAuthController, // OAuth por tenant (Google/HubSpot); callback en /public/oauth
    DevelopersController,
    InboundHookController,
    PublicApiController, // API pública v1 (auth por API key del tenant)
    WorkflowsController,
    ReportsController,
    BillingController,
    WhatsappController,
    ClarivaWebhookController,
    PublicController, // API pública de precios (sin auth)
    // Plataforma (super-admin) — autenticación y audiencia separadas
    PlatformAuthController,
    PlatformController,
  ],
  providers: [PrismaService, AuthService, QueueService, RateLimitService, TenancyMiddleware, RateLimitMiddleware, PlatformSessionService, PlatformGuard, PaymentSettingsService, RealtimeService],
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
