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
    WhatsappController,
  ],
  providers: [PrismaService, AuthService, QueueService, TenancyMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenancyMiddleware).forRoutes("*");
  }
}
