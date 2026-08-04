// Fixture de "tenant vacío / datos ausentes": arrays vacíos, objetos mínimos, nulls
// donde el dato es legítimamente opcional. Sirve para detectar accesos no protegidos.
const ME = { user: { id: "u1", email: "j@t.cl", name: "Javier" }, organization: { id: "o1", name: "Nuevo Tenant", slug: "nuevo" }, role: "owner", permissions: ["*"] };

export function emptyBody(path) {
  if (path.endsWith("/auth/me")) return ME;
  if (path.includes("google-config")) return { clientId: "" };
  if (path.endsWith("/health")) return { ok: true };

  // Inbox: tenant sin etapas, sin conversaciones, contadores en cero
  if (path.startsWith("/lifecycle-stages")) return [];
  if (path.startsWith("/inbox/counters")) return { fixed: { all: 0, mine: 0, unassigned: 0, unanswered: 0 }, agents: [], stages: [] };
  if (path.startsWith("/users/assignable")) return [];
  if (path.includes("/conversations") && path.includes("/context")) return { contact: { id: "c0", phone: "+560", createdAt: "2026-08-01T00:00:00Z" }, stage: null, tags: [], aiNotes: [], ad: null, leadForm: null };
  if (path.includes("/conversations") && path.includes("/messages")) return { conversation: { id: "cv0", contact: { id: "c0", phone: "+560", createdAt: "2026-08-01T00:00:00Z" } }, messages: [] };
  if (path.includes("/conversations")) return { items: [], nextCursor: null };

  // Contactos: sin contactos, meta con listas vacías
  if (path.startsWith("/contacts/meta")) return { counts: { all: 0, blocked: 0 }, lifecycle: [], agents: [], users: [], teams: [], tags: [], countries: [], segments: [], customFields: [] };
  if (path.startsWith("/contacts")) return { page: 1, pageSize: 20, total: 0, items: [] };

  // Agentes / canales / usuarios: vacíos
  if (path.startsWith("/agents/meta/knowledge")) return [];
  if (path.startsWith("/agents/assignable")) return [];
  if (path.match(/\/agents\/[\w-]+/)) return { id: "a0", slug: "nuevo", name: "Nuevo", kind: "reception", description: null, active: false, publishedVersion: null, draftVersion: null, editing: null, versions: [] };
  if (path.startsWith("/agents")) return [];
  if (path.includes("/organizations/me/channels")) return [];
  if (path.startsWith("/channels")) return [];
  if (path.startsWith("/users/roles")) return [];
  if (path.startsWith("/users/permissions")) return [];
  if (path.startsWith("/users/teams")) return [];
  if (path.startsWith("/users")) return [];

  // Workflows: sin flujos
  if (path.includes("/workflows/meta/catalog")) return { triggers: [], nodes: [], variables: [] };
  if (path.match(/\/workflows\/[\w-]+$/)) return { id: "w0", name: "Nuevo", enabled: false, updatedAt: "2026-08-01T00:00:00Z", definition: { trigger: null, variables: [], nodes: [], edges: [] }, trigger: null, nodes: [], edges: [] };
  if (path.match(/\/workflows(\?|$)/)) return [];
  if (path.includes("/workflows")) return [];

  // Integraciones: nada conectado
  if (path.includes("/integrations/notifications")) return { events: [] };
  if (path.includes("/integrations/activity")) return [];
  if (path.startsWith("/integrations")) return { metrics: { active: 0, attention: 0, events24h: 0, webhookErrors7d: 0, lastActivityAt: null, lastSyncAt: null }, meta: null, clariva: null, email: null, platformEmailReady: false, apiPresets: { count: 0, status: null }, ga4: null, customScheduling: null, dentalink: null, google: null, platformGoogleReady: false, hubspot: null, platformHubspotReady: false, capiConfigured: false, automations: { zapier: null, make: null }, webhooks: [], availableEvents: [], catalog: [] };

  // Reportes: periodo sin actividad
  if (path.includes("/reports/overview")) return { days: 30, conversations: { total: 0, newInPeriod: 0, openNow: 0, humanControlNow: 0 }, messages: { inbound: 0, outbound: 0 }, humanHandoffs: 0, appointments: [], leadFunnel: [], ai: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, series: { conversationsPerDay: [], inboundPerDay: [] } };

  // Ajustes
  if (path.startsWith("/settings/hours")) return { timezone: "America/Santiago", hours: {}, holidays: [] };
  if (path.startsWith("/settings")) return {};

  // Billing: sin plan aún
  if (path.includes("/billing/plans")) return [];
  if (path.includes("/billing/me")) return { organization: { name: "Nuevo Tenant", status: "trialing", currency: "CLP" }, plan: null, subscription: null, usage: {}, invoices: [], paymentMethod: null, paymentProvider: "mock" };
  return {};
}
