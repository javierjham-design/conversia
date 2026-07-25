import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { WhatsappController } from "./channels/whatsapp.controller";
import { ConversationsController } from "./conversations/conversations.controller";
import { HealthController } from "./health.controller";
import { OrganizationsController } from "./organizations/organizations.controller";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queues";
import { TenancyMiddleware } from "./tenancy/tenancy.middleware";

@Module({
  controllers: [
    HealthController,
    AuthController,
    OrganizationsController,
    ConversationsController,
    WhatsappController,
  ],
  providers: [PrismaService, AuthService, QueueService, TenancyMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenancyMiddleware).forRoutes("*");
  }
}
