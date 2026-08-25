/** Tipos compartidos de la Bandeja Pro. */

export interface Stage {
  emoji?: string | null;
  code: string;
  name: string;
  color: string | null;
  category?: string;
}

export interface ContactLite {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileName: string | null;
  phone: string | null;
  country?: string | null;
  blocked?: boolean;
  /** foto de perfil (Messenger/IG; WhatsApp no la expone por API) */
  avatarUrl?: string | null;
}

export interface ConvItem {
  id: string;
  status: string;
  aiEnabled: boolean;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  activeAgentId: string | null;
  channelConnectionId: string | null;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  stage: Stage | null;
  contact: ContactLite;
}

export interface Counters {
  firstResponseTargetMinutes?: number;
  fixed: { all: number; mine: number; unassigned: number; unanswered: number; blocked: number };
  agents: { id: string; name: string; count: number }[];
  stages: { code: string; name: string; color: string | null; emoji?: string | null; count: number }[];
  teams: { id: string; name: string; count: number }[];
  allTeams: { id: string; name: string }[];
  views: { id: string; name: string; definition: Record<string, unknown>; count: number }[];
}

/** Filtro activo del clasificador (una entrada del sidebar). */
export type InboxFilter =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "unassigned" }
  | { kind: "unanswered" }
  | { kind: "blocked" }
  | { kind: "agent"; id: string; label: string }
  | { kind: "stage"; code: string; label: string }
  | { kind: "team"; id: string; label: string }
  | { kind: "view"; id: string; label: string };

export interface Msg {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type?: string;
  visibility?: string;
  body: string | null;
  authorType: string;
  authorName?: string | null;
  status: string;
  error?: string | null;
  createdAt: string;
  payload?: Record<string, unknown> | null;
}

export interface ConversationFull {
  id: string;
  status: string;
  aiEnabled: boolean;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  activeAgentId: string | null;
  channelConnectionId: string | null;
  contact: ContactLite & { email?: string | null };
}

export interface AiNote {
  id: string;
  body: string;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  createdBy: string | null;
}

export interface ConvContext {
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    profileName: string | null;
    phone: string | null;
    email: string | null;
    country: string | null;
    source: string | null;
    acquisitionSource: string | null;
    blocked: boolean;
    createdAt: string;
    isReturning: boolean;
    avatarUrl?: string | null;
  };
  stage: Stage | null;
  tags: string[];
  ad: {
    ctwaClid: string | null;
    adId: string | null;
    campaignName: string | null;
    adName: string | null;
    headline: string | null;
    body: string | null;
    imageUrl: string | null;
    sourceUrl: string | null;
    sourceType: string | null;
  } | null;
  leadForm: { formId: string | null; fields: [string, unknown][] } | null;
  aiNotes: AiNote[];
}

export interface ChannelInfo {
  id: string;
  type: string;
  name: string;
  status: string;
  displayPhone: string | null;
  /** foto de la página/cuenta IG del canal */
  pictureUrl?: string | null;
}

export interface Snippet {
  id: string;
  shortcut: string;
  body: string;
}

export function displayName(c: { firstName?: string | null; lastName?: string | null; profileName?: string | null; phone?: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}

/**
 * Marca de tiempo de la LISTA de conversaciones: HORA si es hoy, "Ayer" si es ayer, y la
 * FECHA si es más atrás (día+mes; agrega el año si no es el año en curso). Antes se mostraba
 * siempre la hora, y un mensaje de días previos parecía de hoy.
 */
export function formatListTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  if (t >= startOfToday - 86_400_000) return "Ayer";
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("es-CL", { day: "2-digit", month: "short" });
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function initials(c: { firstName?: string | null; lastName?: string | null; profileName?: string | null; phone?: string | null }): string {
  const name = displayName(c);
  const parts = name.split(" ").filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "");
}

/** Paleta de avatares (fondo suave + texto legible en claro y oscuro). */
const AVATAR_PALETTE = [
  "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200",
  "bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-200",
  "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-200",
];

/** Color de avatar determinista según el nombre (mismo contacto = mismo color). */
export function avatarColor(c: { firstName?: string | null; lastName?: string | null; profileName?: string | null; phone?: string | null }): string {
  const key = displayName(c);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

/** Resuelve variables {{contact.*}} de snippets con los datos reales. */
export function renderSnippet(body: string, contact: ContactLite & { email?: string | null }): string {
  const map: Record<string, string> = {
    "contact.firstName": contact.firstName ?? "",
    "contact.lastName": contact.lastName ?? "",
    "contact.name": displayName(contact),
    "contact.phone": contact.phone ?? "",
    "contact.email": contact.email ?? "",
  };
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => map[key] ?? "");
}
