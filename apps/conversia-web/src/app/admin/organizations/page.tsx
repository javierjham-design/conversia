"use client";
import { useEffect, useMemo, useState } from "react";
import { padmin } from "@/lib/platform-api";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  country: string | null;
  createdAt: string;
  deletedAt: string | null;
  plan: { code: string; name: string } | null;
  subscriptionStatus: string | null;
  counts: { users: number; conversations: number; agents: number };
  messaging: { blocked: boolean; blockedBy: string | null; reason: string | null };
  lifecycle?: { stage: string | null; setupPaid: boolean; deliveredAt: string | null };
};

const STATUS_LABEL: Record<string, string> = { ACTIVE: "Activo", TRIAL: "Prueba", SUSPENDED: "Suspendido", CANCELLED: "Cancelado" };
const STATUS_COLOR: Record<string, string> = { ACTIVE: "var(--ok)", TRIAL: "var(--warn)", SUSPENDED: "var(--danger)", CANCELLED: "var(--ink-dim)" };

/** Semáforo de implementación (F10): dónde está el cliente en su puesta en marcha. */
function lifecycleBadge(lc?: { stage: string | null; setupPaid: boolean; deliveredAt: string | null }): { label: string; color: string } | null {
  if (!lc) return null;
  if (lc.stage === "active" || lc.deliveredAt) return { label: "🟢 En vivo", color: "var(--ok)" };
  if (lc.stage === "implementing" || lc.setupPaid) return { label: "🟡 Implementando", color: "var(--warn)" };
  return { label: "⚪ Prospecto", color: "var(--ink-dim)" };
}

export default function AdminOrganizations() {
  const [rows, setRows] = useState<OrgRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    padmin<OrgRow[]>("/platform/organizations")
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const term = q.trim().toLowerCase();
    return rows.filter((r) => !r.deletedAt && (!term || r.name.toLowerCase().includes(term) || r.slug.toLowerCase().includes(term)));
  }, [rows, q]);

  return (
    <div style={{ maxWidth: 1040 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Tenants</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>Clientes de Conversia. Toca uno para configurarlo.</p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar por nombre…"
        style={{ width: "100%", maxWidth: 360, padding: "10px 13px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14, marginBottom: 16 }}
      />

      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
      {!rows ? (
        <p className="text-dim">Cargando…</p>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Aún no hay tenants de Conversia.</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>
            Los clientes se crean registrándose en app.conversia.cl; aquí los configuras (plan, IA, rubro, mensajería).
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((r) => (
            <a key={r.id} href={`/admin/organizations/${r.id}`} className="card" style={{ padding: 16, textDecoration: "none", color: "var(--ink)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{r.name}</p>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{r.slug} · {r.country ?? "—"}</p>
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[r.status] ?? "var(--ink-dim)" }}>
                ● {STATUS_LABEL[r.status] ?? r.status}
              </span>
              {(() => { const b = lifecycleBadge(r.lifecycle); return b ? <span style={{ fontSize: 11, fontWeight: 600, color: b.color }}>{b.label}</span> : null; })()}
              <span className="text-dim" style={{ fontSize: 12, minWidth: 90 }}>{r.plan?.name ?? "Sin plan"}</span>
              <span className="text-dim" style={{ fontSize: 12 }}>
                {r.counts.users}👤 · {r.counts.conversations}💬 · {r.counts.agents}🤖
              </span>
              {r.messaging.blocked ? (
                <span title={r.messaging.reason ?? ""} style={{ fontSize: 11, color: "var(--danger)", fontWeight: 600 }}>✉ bloqueado</span>
              ) : null}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
