// Fixture "registros con opcionales en null": listas NO vacías, pero cada ítem
// omite/anula campos opcionales (contacto sin tags/stage/email, conversación
// sin asignado, agente sin descripción...). Caza accesos por-ítem no protegidos.
const ME = { user: { id: "u1", email: "j@t.cl", name: "Javier" }, organization: { id: "o1", name: "Tenant", slug: "t" }, role: "owner", permissions: ["*"] };
const BARE_CONTACT = { id: "c1", phone: "+56900000000", displayName: null, name: null, email: null, country: null, createdAt: "2026-08-01T00:00:00Z", isReturning: false, source: null, blocked: false, stage: null, tags: null, agent: null };
const BARE_CONV = { id: "cv1", contact: BARE_CONTACT, lastMessageAt: null, unread: 0, status: "open", assignedTo: null, mode: "ai", stage: null, tags: null, windowLabel: null, windowLevel: null, channelConnectionId: null, lastMessage: null };

export function nullsBody(path) {
  if (path.endsWith("/auth/me")) return ME;
  if (path.includes("google-config")) return { clientId: "" };
  if (path.endsWith("/health")) return { ok: true };

  if (path.startsWith("/lifecycle-stages")) return [{ code: "x", name: "Etapa", emoji: null, color: null, category: "activo" }];
  if (path.startsWith("/inbox/counters")) return { fixed: { all: 1, mine: 0, unassigned: 1, unanswered: 1 }, agents: [{ agentId: "a1", name: "Agente", count: null }], stages: [] };
  if (path.startsWith("/users/assignable")) return [{ userId: "u1", name: null }];
  if (path.startsWith("/channels")) return [{ id: "ch1", type: null, status: null, label: null, name: null }];
  if (path.includes("/conversations") && path.includes("/context")) return { contact: BARE_CONTACT, stage: null, tags: null, aiNotes: null, ad: null, leadForm: null };
  if (path.includes("/conversations") && path.includes("/messages")) return { conversation: BARE_CONV, messages: [{ id: "m1", direction: "inbound", body: null, createdAt: "2026-08-03T00:00:00Z", status: null, authorType: null }] };
  if (path.includes("/conversations")) return { items: [BARE_CONV], nextCursor: null };

  if (path.startsWith("/contacts/meta")) return { counts: { all: 1, blocked: 0 }, lifecycle: [{ code: "x", name: "Etapa", color: null, category: "activo", count: 1 }], agents: [], users: [], teams: [], tags: [], countries: [], segments: [{ id: "s1", name: "Todos", isDefault: true }], customFields: [] };
  if (path.startsWith("/contacts")) return { page: 1, pageSize: 20, total: 1, items: [BARE_CONTACT] };

  if (path.startsWith("/agents/meta/knowledge")) return [];
  if (path.startsWith("/agents/assignable")) return [];
  if (path.match(/\/agents\/[\w-]+/)) return { id: "a1", slug: "a", name: "Agente", kind: "reception", description: null, active: false, publishedVersion: null, draftVersion: 1, editing: { systemPrompt: "", config: {}, tools: null, status: "draft", version: 1 }, versions: [] };
  if (path.startsWith("/agents")) return [{ id: "a1", name: "Agente", slug: "a", enabled: false, active: false, model: null, description: null, conversationsToday: null }];
  if (path.includes("/organizations/me/channels")) return [{ id: "ch1", name: null, type: null, defaultAgentId: null }];
  if (path.startsWith("/users/roles")) return [{ code: "r", name: "Rol", permissions: null }];
  if (path.startsWith("/users/permissions")) return [{ module: "Mod", permissions: null }];
  if (path.startsWith("/users/teams")) return [];
  if (path.startsWith("/users")) return [{ membershipId: "m1", userId: "u1", name: null, email: "x@y.cl", roleCode: "r", active: true, conversations: null }];

  if (path.includes("/workflows/meta/catalog")) return { triggers: [], nodes: [], variables: [] };
  if (path.match(/\/workflows\/[\w-]+$/)) return { id: "w1", name: "Flujo", enabled: false, updatedAt: "2026-08-01T00:00:00Z", definition: { trigger: null, variables: null, nodes: null, edges: null }, trigger: null, nodes: null, edges: null };
  if (path.match(/\/workflows(\?|$)/)) return [{ id: "w1", name: "Flujo", enabled: false, status: null, updatedAt: "2026-08-01T00:00:00Z", nodeCount: null }];
  if (path.includes("/workflows")) return [];

  if (path.includes("/integrations/notifications")) return { events: [] };
  if (path.includes("/integrations/activity")) return [{ id: "e1", provider: null, status: null, message: null, createdAt: "2026-08-03T00:00:00Z" }];
  if (path.startsWith("/integrations")) return { metrics: { active: 0, attention: 0, events24h: 0, webhookErrors7d: 0, lastActivityAt: null, lastSyncAt: null }, meta: null, clariva: null, email: null, platformEmailReady: false, apiPresets: { count: 0, status: null }, ga4: null, customScheduling: null, dentalink: null, google: null, platformGoogleReady: false, hubspot: null, platformHubspotReady: false, capiConfigured: false, automations: { zapier: null, make: null }, webhooks: null, availableEvents: null, catalog: [{ key: "meta", name: "Meta", category: null, status: null, description: null }] };

  if (path.includes("/reports/overview")) return { days: 30, conversations: { total: 0, newInPeriod: 0, openNow: 0, humanControlNow: 0 }, messages: { inbound: 0, outbound: 0 }, humanHandoffs: 0, appointments: null, leadFunnel: null, ai: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, series: { conversationsPerDay: null, inboundPerDay: null } };

  if (path.startsWith("/settings/hours")) return { timezone: "America/Santiago", hours: null, holidays: null };
  if (path.startsWith("/settings/general")) return { name: null, slug: null, timezone: null, logoUrl: null, industry: null, currency: null, language: null, contactEmail: null, contactPhone: null, website: null };
  if (path.startsWith("/settings")) return {};

  if (path.includes("/billing/plans")) return [{ code: "x", name: "Plan", priceClp: null, priceUsd: null, interval: null, limits: null }];
  if (path.includes("/billing/me")) return { organization: { name: null, status: null, currency: null }, plan: null, subscription: null, usage: {}, invoices: null, paymentMethod: null, paymentProvider: null };
  return {};
}
