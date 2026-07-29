import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { getEnv } from "@conversia/config";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";

async function bootstrap() {
  const env = getEnv();
  // rawBody: necesario para verificar la firma HMAC de los webhooks de Meta
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Límites de tamaño de cuerpo (anti-DoS por payloads gigantes) sin doble
  // parseo. 2mb: el import CSV de contactos admite hasta 10 000 filas por POST.
  app.useBodyParser("json", { limit: "2mb" });
  app.useBodyParser("urlencoded", { limit: "512kb", extended: false });

  // Detrás del proxy de Railway/Next: honra X-Forwarded-* (IP, proto)
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Cabeceras de seguridad. La API sólo devuelve JSON → CSP restrictiva.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: [env.WEB_URL], credentials: true });

  // Railway/PaaS inyectan PORT; en local se usa API_PORT
  const port = Number(process.env.PORT ?? env.API_PORT);
  await app.listen(port, "0.0.0.0");
  console.log(`✔ API Conversia en puerto ${port} (${env.NODE_ENV})`);
}

void bootstrap();
