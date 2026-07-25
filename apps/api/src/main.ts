import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { getEnv } from "@conversia/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = getEnv();
  // rawBody: necesario para verificar la firma HMAC de los webhooks de Meta
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({ origin: [env.WEB_URL], credentials: true });
  await app.listen(env.API_PORT);
  console.log(`✔ API Conversia en http://localhost:${env.API_PORT} (${env.NODE_ENV})`);
}

void bootstrap();
