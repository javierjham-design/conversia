"use client";
import { use, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

/**
 * LISTA de agentes de IA de un tenant, en la consola de plataforma. Paridad
 * funcional con el panel de agentes de TuBot pero con el design system "Nocturna".
 * Usa el id de la ruta [id] y habla con la API de plataforma vía `padmin`.
 */
type AgentRow = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  active: boolean;
  publishedVersion: number | null;
  publishedAt: string | null;
  hasDraft: boolean;
  model: string | null;
  avatar?: string | null;
};

const KINDS: [string, string][] = [
  ["orchestrator", "Recepcionista / Orquestador"],
  ["receptionist", "Recepcionista"],
  ["recepcion", "Recepcionista"],
  ["sales", "Ventas / Especialista"],
  ["ventas", "Ventas"],
  ["scheduler", "Agendamiento"],
  ["agendamiento", "Agendamiento"],
  ["follow_up", "Seguimiento"],
  ["support", "Soporte"],
  ["soporte", "Soporte"],
  ["router", "Derivador"],
  ["custom", "Personalizado"],
];
const KIND_LABEL = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;

/** Emoji por defecto si el agente no tiene uno guardado (config.emoji). */
const DEFAULT_EMOJI = "🤖";

const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
const label: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)" };

export default function OrgAgentsList({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [orgName, setOrgName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = () => padmin<AgentRow[]>(`/platform/organizations/${id}/agents`).then(setRows).catch((e) => setError((e as Error).message));

  useEffect(() => {
    load();
    padmin<{ organization: { name: string } }>(`/platform/organizations/${id}`).then((x) => setOrgName(x.organization.name)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div style={{ maxWidth: 940 }}>
      <a href={`/admin/organizations/${id}`} className="text-dim" style={{ fontSize: 13, textDecoration: "none" }}>← Volver a la ficha</a>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", margin: "8px 0 4px" }}>
        <h1 className="display" style={{ fontSize: 26, margin: 0 }}>Agentes de IA</h1>
        {orgName ? <span className="text-dim" style={{ fontSize: 13 }}>{orgName}</span> : null}
        <button className="btn-accent" onClick={() => setShowNew(true)} style={{ marginLeft: "auto" }}>+ Nuevo agente</button>
      </div>
      <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>Configura el cerebro, las acciones y el conocimiento de cada agente, y pruébalo en vivo antes de publicar.</p>

      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      {!rows ? (
        <p className="text-dim">Cargando agentes…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 24 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Este tenant aún no tiene agentes.</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 14px" }}>
            Crea el primero (o instala un rubro desde la ficha para que traiga sus agentes y prompts del paquete vertical).
          </p>
          <button className="btn-accent" onClick={() => setShowNew(true)}>+ Crear primer agente</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {rows.map((a) => {
            const published = a.publishedVersion != null;
            return (
              <div key={a.id} className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <span
                    aria-hidden
                    style={{ width: 40, height: 40, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: 12, background: "var(--acc-dim)", fontSize: 20 }}
                  >
                    {a.avatar || DEFAULT_EMOJI}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</p>
                    <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{KIND_LABEL(a.kind)}</p>
                  </div>
                </div>

                {a.description ? <p className="text-dim" style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>{a.description}</p> : null}

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ fontWeight: 600, color: published && a.active ? "var(--ok)" : published ? "var(--ink-dim)" : "var(--warn)" }}>
                    ● {published ? (a.active ? "Activo" : "Inactivo") : "Borrador"}
                  </span>
                  {published ? <span className="text-dim">v{a.publishedVersion}</span> : <span className="text-dim">nunca publicado</span>}
                  {a.hasDraft ? <span style={{ color: "var(--warn)" }}>· borrador sin publicar</span> : null}
                </div>

                <p className="text-dim" style={{ margin: 0, fontSize: 11, fontFamily: "ui-monospace, monospace" }}>{a.model || "modelo por defecto"}</p>

                <a
                  href={`/admin/organizations/${id}/agents/${a.id}`}
                  className="btn-accent"
                  style={{ marginTop: "auto", textAlign: "center", textDecoration: "none" }}
                >
                  Abrir configurador
                </a>
              </div>
            );
          })}
        </div>
      )}

      {showNew ? <NewAgentModal orgId={id} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} /> : null}
    </div>
  );
}

function NewAgentModal({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (agentId: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("custom");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("El nombre es obligatorio."); return; }
    setBusy(true); setErr(null);
    try {
      const a = await padmin<{ id: string }>(`/platform/organizations/${orgId}/agents`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), kind, description: description.trim() || undefined }),
      });
      onCreated(a.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={create} className="card" style={{ width: "100%", maxWidth: 480, padding: 22 }}>
        <h2 className="display" style={{ fontSize: 19, margin: "0 0 12px" }}>Nuevo agente</h2>
        <label style={label}>Nombre
          <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Recepcionista" autoFocus />
        </label>
        <label style={{ ...label, display: "block", marginTop: 12 }}>Tipo
          <select style={field} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.filter((k, i, arr) => arr.findIndex(([v]) => v === k[0]) === i).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
        <label style={{ ...label, display: "block", marginTop: 12 }}>Descripción interna (opcional)
          <input style={field} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este agente" />
        </label>
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</p> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} className="nav-item" style={{ flex: 1, width: "auto", height: 42, justifyContent: "center", border: "1px solid var(--line)", background: "transparent", cursor: "pointer" }}>Cancelar</button>
          <button className="btn-accent" type="submit" disabled={busy} style={{ flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Creando…" : "Crear agente"}</button>
        </div>
      </form>
    </div>
  );
}
