"use client";
import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Search } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Contact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileName: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  createdAt: string;
  stage: { code: string; name: string; color: string | null } | null;
  conversation: { id: string; status: string } | null;
  channels: string[];
  tags: { name: string; color: string | null }[];
};

function displayName(c: Contact): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.profileName || c.phone || "Sin nombre";
}
function initials(c: Contact): string {
  return displayName(c).slice(0, 2).toUpperCase();
}

export default function Clientes() {
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: "1", pageSize: "50" });
      if (term.trim()) qs.set("q", term.trim());
      const res = await api<{ items: Contact[]; total: number }>(`/contacts?${qs.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <AppShell>
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Clientes</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>{total} contactos.</p>

        <div style={{ position: "relative", maxWidth: 420, marginBottom: 18 }}>
          <Search size={16} className="text-dim" style={{ position: "absolute", left: 13, top: 12 }} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o teléfono…"
            style={{ width: "100%", padding: "10px 13px 10px 38px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }}
          />
        </div>

        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
        {loading ? (
          <p className="text-dim">Cargando…</p>
        ) : items.length === 0 ? (
          <div className="card" style={{ padding: 24 }}><p className="text-dim" style={{ margin: 0 }}>Sin contactos.</p></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((c) => (
              <div key={c.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ width: 40, height: 40, flexShrink: 0, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14 }}>{initials(c)}</span>
                <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{displayName(c)}</p>
                  <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{c.phone ?? c.email ?? "—"}{c.country ? ` · ${c.country}` : ""}</p>
                </div>
                {c.stage ? (
                  <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: "var(--acc-dim)", color: "var(--acc-deep)", fontWeight: 600 }}>{c.stage.name}</span>
                ) : null}
                {c.tags.slice(0, 3).map((t) => (
                  <span key={t.name} className="text-dim" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--line)" }}>{t.name}</span>
                ))}
                {c.conversation ? (
                  <a href={`/conversaciones?c=${c.conversation.id}`} className="text-accent" style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none", marginLeft: "auto" }}>
                    <MessageCircle size={15} /> Abrir chat
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}
