import { Controller, Get } from "@nestjs/common";
import { getEnv } from "@conversia/config";

@Controller("health")
export class HealthController {
  @Get()
  health() {
    return { ok: true, service: "conversia-api", env: getEnv().NODE_ENV, uptime: process.uptime() };
  }
}
