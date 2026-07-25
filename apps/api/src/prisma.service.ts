import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { getPrisma, withTenant, type TenantTx } from "@conversia/database";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  /**
   * Cliente directo: SOLO para operaciones de plataforma (registro de
   * organizaciones, login por email). Datos de tenant → withTenant().
   */
  readonly client = getPrisma();

  withTenant<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(orgId, fn, this.client);
  }

  onModuleDestroy() {
    return this.client.$disconnect();
  }
}
