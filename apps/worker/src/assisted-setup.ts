import { getAdminPrisma, withTenant, type TenantTx } from "@conversia/database";

/**
 * MONTAJE ASISTIDO — capacidad acotada para que el agente de implementación de
 * TuBot escriba SOLO objetos de configuración en el tenant de un cliente que lo
 * AUTORIZÓ, sin poder tocar sus conversaciones/contactos ni enviar mensajes.
 *
 * Seguridad (por qué es seguro cruzar tenants aquí):
 * - La RLS es POR FILA (`organization_id = app.org_id`), no por tabla. Por eso
 *   este módulo NUNCA entrega una transacción cruda al llamador: expone un
 *   servicio ANGOSTO con solo operaciones de configuración (agentes, flujos,
 *   servicios, base de conocimiento) dentro del scope autorizado.
 * - El grant se verifica con la conexión ADMIN (cross-tenant por diseño, igual
 *   que la resolución de tenant por canal); la ESCRITURA va por `withTenant` del
 *   cliente (rol de app, RLS activa) — así ni siquiera con un bug se escaparía a
 *   otro tenant.
 * - Toda acción se audita en el `audit_log` del cliente con
 *   `actorType = "assisted_setup"` y `actorId = <org de TuBot>`.
 * - Sin grant vigente / revocado / expirado / de otro proveedor → se niega todo.
 *
 * Dependencias inyectables para poder testear el LÍMITE sin base de datos.
 */

export const ASSISTED_SETUP_ACTOR = "assisted_setup" as const;
export type AssistedSetupScope = "agents" | "flows" | "services" | "knowledge";

export class AssistedSetupDenied extends Error {
  readonly kind = "assisted_setup_denied";
}

export interface AssistedGrant {
  id: string;
  scopes: AssistedSetupScope[];
  expiresAt: Date;
}

export interface AssistedSetupDeps {
  /** Busca el grant ACTIVO del cliente para ESTE proveedor (TuBot). Admin/bypass RLS. */
  findActiveGrant: (clientOrgId: string, providerOrgId: string) => Promise<AssistedGrant | null>;
  /** Corre `fn` en el contexto de tenant del CLIENTE (RLS). */
  runInTenant: <T>(clientOrgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  now?: () => Date;
}

export interface UpsertAgentInput {
  slug: string;
  name: string;
  systemPrompt: string;
  kind?: string;
  tools?: string[];
  model?: string | null;
}

/**
 * Servicio ANGOSTO del montaje asistido. SOLO operaciones de configuración.
 * No expone conversaciones, contactos, mensajes ni la transacción. (Las tools
 * de KB/servicios/flujos se agregan en el follow-up, respetando su esquema.)
 */
export interface AssistedSetupService {
  readonly scopes: AssistedSetupScope[];
  getSetupState(): Promise<{ agents: number; flows: number; services: number; knowledge: number }>;
  upsertClientAgent(input: UpsertAgentInput): Promise<{ agentId: string }>;
}

/** Dependencias reales de producción. */
export const defaultAssistedSetupDeps: AssistedSetupDeps = {
  findActiveGrant: async (clientOrgId, providerOrgId) => {
    const admin = getAdminPrisma();
    const g = await admin.assistedSetupGrant.findFirst({
      where: { organizationId: clientOrgId, grantedByOrganizationId: providerOrgId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!g) return null;
    const scopes = (Array.isArray(g.scopes) ? g.scopes : []) as AssistedSetupScope[];
    return { id: g.id, scopes, expiresAt: g.expiresAt };
  },
  runInTenant: (clientOrgId, fn) => withTenant(clientOrgId, fn),
};

/**
 * Abre el montaje asistido para un cliente. Verifica el grant y devuelve el
 * servicio angosto. Lanza `AssistedSetupDenied` si no hay autorización vigente.
 */
export interface AssistedSetupOptions {
  /** Canal del cliente que autorizó configurar: el agente creado queda como su predeterminado. */
  scopeChannelId?: string | null;
}

export async function openAssistedSetup(
  clientOrgId: string,
  providerOrgId: string,
  deps: AssistedSetupDeps = defaultAssistedSetupDeps,
  opts: AssistedSetupOptions = {},
): Promise<AssistedSetupService> {
  if (!clientOrgId || !providerOrgId) throw new AssistedSetupDenied("Faltan organizaciones");
  if (clientOrgId === providerOrgId) throw new AssistedSetupDenied("El proveedor no puede montarse a sí mismo");
  const grant = await deps.findActiveGrant(clientOrgId, providerOrgId);
  const now = deps.now?.() ?? new Date();
  if (!grant) throw new AssistedSetupDenied("El cliente no autorizó el montaje asistido (o fue revocado)");
  if (grant.expiresAt.getTime() <= now.getTime()) throw new AssistedSetupDenied("La autorización de montaje asistido expiró");

  const scopes = grant.scopes;
  const requireScope = (s: AssistedSetupScope) => {
    if (!scopes.includes(s)) throw new AssistedSetupDenied(`El montaje asistido no tiene el permiso «${s}»`);
  };
  const audit = (tx: TenantTx, action: string, entityType: string, entityId: string | null, after: unknown) =>
    tx.auditLog.create({
      data: {
        organizationId: clientOrgId,
        actorType: ASSISTED_SETUP_ACTOR,
        actorId: providerOrgId,
        action,
        entityType,
        entityId: entityId ?? undefined,
        after: after as object,
      },
    });

  return {
    scopes,
    async getSetupState() {
      return deps.runInTenant(clientOrgId, async (tx) => {
        const [agents, flows, services, knowledge] = await Promise.all([
          tx.agent.count({ where: { deletedAt: null } }),
          tx.workflow.count(),
          tx.service.count(),
          tx.knowledgeDocument.count(),
        ]);
        return { agents, flows, services, knowledge };
      });
    },
    async upsertClientAgent(input) {
      requireScope("agents");
      return deps.runInTenant(clientOrgId, async (tx) => {
        const existing = await tx.agent.findFirst({ where: { organizationId: clientOrgId, slug: input.slug, deletedAt: null } });
        const config = input.model ? { model: input.model } : {};
        let agentId: string;
        if (existing) {
          const lastVersion = await tx.agentVersion.findFirst({ where: { agentId: existing.id }, orderBy: { version: "desc" } });
          const version = await tx.agentVersion.create({
            data: {
              organizationId: clientOrgId,
              agentId: existing.id,
              version: (lastVersion?.version ?? 0) + 1,
              status: "PUBLISHED",
              systemPrompt: input.systemPrompt,
              config,
              tools: input.tools ?? [],
              publishedAt: new Date(),
            },
          });
          await tx.agent.update({ where: { id: existing.id }, data: { name: input.name, currentVersionId: version.id } });
          agentId = existing.id;
        } else {
          const agent = await tx.agent.create({
            data: { organizationId: clientOrgId, slug: input.slug, name: input.name, kind: input.kind ?? "custom", active: true },
          });
          const version = await tx.agentVersion.create({
            data: {
              organizationId: clientOrgId,
              agentId: agent.id,
              version: 1,
              status: "PUBLISHED",
              systemPrompt: input.systemPrompt,
              config,
              tools: input.tools ?? [],
              publishedAt: new Date(),
            },
          });
          await tx.agent.update({ where: { id: agent.id }, data: { currentVersionId: version.id } });
          agentId = agent.id;
        }
        // Si el cliente autorizó un canal puntual, deja este agente como su predeterminado
        // (verificando que el canal sea de su misma cuenta — la RLS ya lo acota).
        if (opts.scopeChannelId) {
          const ch = await tx.channelConnection.findUnique({ where: { id: opts.scopeChannelId }, select: { id: true } });
          if (ch) {
            await tx.channelConnection.update({ where: { id: ch.id }, data: { defaultAgentId: agentId } });
            await audit(tx, "assisted_setup.channel_default_agent", "channel_connection", ch.id, { agentId, slug: input.slug });
          }
        }
        await audit(tx, "assisted_setup.agent_upsert", "agent", agentId, { slug: input.slug, name: input.name });
        return { agentId };
      });
    },
  };
}
