"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Data = {
  connections: { id: string; type: string; name: string; status: string }[];
  intents: { type: string; status: string }[];
};

const LABEL: Record<string, { label: string; emoji: string }> = {
  whatsapp: { label: "WhatsApp", emoji: "🟢" },
  WHATSAPP_CLOUD: { label: "WhatsApp", emoji: "🟢" },
  instagram: { label: "Instagram", emoji: "📸" },
  INSTAGRAM: { label: "Instagram", emoji: "📸" },
  messenger: { label: "Messenger", emoji: "💬" },
  MESSENGER: { label: "Messenger", emoji: "💬" },
  tiktok: { label: "TikTok", emoji: "🎵" },
};

export default function Canales() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Data>("/onboarding/channels").then(setD).catch((e) => setError((e as Error).message));
  }, []);

  const rows: { key: string; label: string; emoji: string; status: string }[] = [];
  if (d) {
    for (const c of d.connections) {
      const m = LABEL[c.type] ?? { label: c.type, emoji: "🔗" };
      rows.push({ key: "conn-" + c.id, label: c.name || m.label, emoji: m.emoji, status: c.status === "active" ? "Conectado" : "Pendiente" });
    }
    for (const i of d.intents) {
      if (d.connections.some((c) => (LABEL[c.type]?.label ?? "") === (LABEL[i.type]?.label ?? i.type))) continue;
      const m = LABEL[i.type] ?? { label: i.type, emoji: "🔗" };
      rows.push({ key: "intent-" + i.type, label: m.label, emoji: m.emoji, status: "Pendiente de conexión" });
    }
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 680, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Canales</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Dónde conversan tus clientes contigo.</p>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
        {!d ? (
          <p className="text-dim">Cargando…</p>
        ) : rows.length === 0 ? (
          <div className="card" style={{ padding: 24 }}>
            <p style={{ margin: 0 }}>Aún no tienes canales configurados.</p>
            <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Nuestro equipo te ayuda a conectar WhatsApp, Instagram, Messenger o TikTok.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((r) => (
              <div key={r.key} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{ fontSize: 24 }}>{r.emoji}</span>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 15 }}>{r.label}</span>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, background: r.status === "Conectado" ? "var(--acc-dim)" : "transparent", color: r.status === "Conectado" ? "var(--acc-deep)" : "var(--warn)", border: r.status === "Conectado" ? "none" : "1px solid var(--line)" }}>
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}
