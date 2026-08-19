import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BillingSuspensionGuard } from "./tenancy/billing-suspension.guard";
import { AgentsController } from "./agents/agents.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { ChannelsController } from "./channels/channels.controller";
import { WhatsappController } from "./channels/whatsapp.controller";
import { MetaAppController } from "./channels/meta-app.controller";
import { ContactsController } from "./contacts/contacts.controller";
import { CrmController } from "./contacts/crm.controller";
import { LifecycleController } from "./contacts/lifecycle.controller";
import { ContactFieldsController } from "./contacts/fields.controller";
import { TagsController } from "./contacts/tags.controller";
import { ConversationsController } from "./conversations/conversations.controller";
import { InboxController } from "./conversations/inbox.controller";
import { RealtimeService } from "./common/realtime.service";
import { HealthController } from "./health.controller";
import { DevelopersController } from "./integrations/developers.controller";
import { InboundHookController } from "./integrations/inbound-hook.controller";
import { CatalogWebhookController } from "./integrations/catalog-webhook.controller";
import { MetaCrmController } from "./integrations/meta-crm.controller";
import { MetaCrmWebhookController } from "./integrations/meta-crm-webhook.controller";
import { IntegrationsController } from "./integrations/integrations.controller";
import { MetaController } from "./integrations/meta.controller";
import { OAuthController } from "./integrations/oauth.controller";
import { PublicApiController } from "./integrations/public-api.controller";
import { OrganizationsController } from "./organizations/organizations.controller";
import { OnboardingController } from "./organizations/onboarding.controller";
import { SupportController } from "./organizations/support.controller";
import { NotificationsController } from "./notifications/notifications.controller";
import { SettingsController } from "./organizations/settings.controller";
import { AssistedSetupController } from "./assisted-setup/assisted-setup.controller";
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
    OnboardingController, // checklist de activación del cliente nuevo
    SupportController, // soporte in-app: el tenant reporta, el Super Admin lo ve
    NotificationsController, // campana in-app + dispositivos Web Push + presencia
    SettingsController, // Centro de Configuración del tenant (/settings)
    AssistedSetupController, // montaje asistido: el cliente autoriza/revoca a TuBot
    AgentsController,
    ConversationsController,
    InboxController, // clasificador de la Bandeja: conteos, bandejas, snippets, asistente IA
    ContactsController,
    CrmController, // tablero CRM de leads (pipeline por etapa)
    LifecycleController, // etapas del ciclo de vida editables por tenant
    ContactFieldsController, // campos personalizados de contacto (/settings)
    TagsController, // etiquetas del tenant (/settings)
    ChannelsController,
    UsersController,
    IntegrationsController,
    MetaController,
    MetaCrmController, // integración Meta CRM (Lead Ads) — conexión separada por tenant
    OAuthController, // OAuth por tenant (Google/HubSpot); callback en /public/oauth
    DevelopersController,
    InboundHookController,
    CatalogWebhookController,
    PublicApiController, // API pública v1 (auth por API key del tenant)
    WorkflowsController,
    ReportsController,
    BillingController,
    WhatsappController,
    MetaAppController,
    MetaCrmWebhookController, // webhook page/leadgen de la app separada TuBot CRM
    ClarivaWebhookController,
    PublicController, // API pública de precios (sin auth)
    // Plataforma (super-admin) — autenticación y audiencia separadas
    PlatformAuthController,
    PlatformController,
  ],
  providers: [PrismaService, AuthService, QueueService, RateLimitService, TenancyMiddleware, RateLimitMiddleware, PlatformSessionService, PlatformGuard, PaymentSettingsService, RealtimeService, { provide: APP_GUARD, useClass: BillingSuspensionGuard }],
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
