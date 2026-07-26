import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { getAdminPrisma, getPrisma, withTenant, type TenantTx } from "@conversia/database";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  /**
   * Cliente ADMIN (superusuario): SOLO operaciones de plataforma que cruzan
   * tenants por diseño (registro de organizaciones, login de usuarios
   * globales). Todo dato de tenant va por withTenant().
   */
  readonly admin = getAdminPrisma();

  withTenant<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(orgId, fn);
  }

  async onModuleDestroy() {
    await Promise.all([getPrisma().$disconnect(), this.admin.$disconnect()]);
  }
}
