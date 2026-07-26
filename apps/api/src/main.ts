import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { getEnv } from "@conversia/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = getEnv();
  // rawBody: necesario para verificar la firma HMAC de los webhooks de Meta
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({ origin: [env.WEB_URL], credentials: true });
  // Railway/PaaS inyectan PORT; en local se usa API_PORT
  const port = Number(process.env.PORT ?? env.API_PORT);
  await app.listen(port, "0.0.0.0");
  console.log(`✔ API Conversia en puerto ${port} (${env.NODE_ENV})`);
}

void bootstrap();
