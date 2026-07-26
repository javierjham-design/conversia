import { randomUUID } from "node:crypto";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { getEnv } from "@conversia/config";

/**
 * Filtro global de excepciones (ASVS 7.4 / API8:2023):
 * - HttpException conocidas (zod/negocio) → status y mensaje tal cual (seguros).
 * - Cualquier otro error → 500 genérico SIN stack trace ni detalle interno,
 *   con un errorId correlacionable con el log del servidor.
 * - Nunca filtra rutas internas, SQL ni secretos al cliente.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private logger = new Logger("Exception");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      return res.status(status).json(
        typeof body === "string" ? { statusCode: status, message: body, requestId } : { ...(body as object), requestId },
      );
    }

    // Error no controlado: log completo server-side, respuesta opaca al cliente
    const errorId = randomUUID();
    this.logger.error(
      `errorId=${errorId} requestId=${requestId} path=${req.method} ${(req.originalUrl ?? "").split("?")[0]} :: ${(exception as Error)?.message}`,
      getEnv().NODE_ENV === "production" ? undefined : (exception as Error)?.stack,
    );
    return res.status(500).json({
      statusCode: 500,
      message: "Error interno del servidor",
      errorId,
      requestId,
    });
  }
}
