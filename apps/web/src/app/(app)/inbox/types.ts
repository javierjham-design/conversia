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
  };
  stage: Stage | null;
  tags: string[];
  ad: {
    ctwaClid: string | null;
    adId: string | null;
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
}

export interface Snippet {
  id: string;
  shortcut: string;
  body: string;
}

export function displayName(c: { firstName?: string | null; lastName?: string | null; profileName?: string | null; phone?: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}

export function initials(c: { firstName?: string | null; lastName?: string | null; profileName?: string | null; phone?: string | null }): string {
  const name = displayName(c);
  const parts = name.split(" ").filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "");
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
