"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Appt = {
  id: string;
  professionalName: string | null;
  serviceName: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  contact: { name: string; phone: string | null };
};

const STATUS_COLOR: Record<string, string> = { CONFIRMED: "var(--ok)", BOOKED: "var(--acc-deep)", PENDING: "var(--warn)", CANCELLED: "var(--danger)", COMPLETED: "var(--ink-dim)" };

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "long" });
}
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
}

export default function Agenda() {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    api<{ appointments: Appt[] }>(`/agenda/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => setAppts(r.appointments))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  // Agrupa por día.
  const groups: { day: string; items: Appt[] }[] = [];
  for (const a of appts) {
    const k = dayKey(a.startsAt);
    const g = groups.find((x) => x.day === k);
    if (g) g.items.push(a);
    else groups.push({ day: k, items: [a] });
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Agenda</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tus próximas citas (30 días).</p>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {loading ? (
          <p className="text-dim">Cargando…</p>
        ) : appts.length === 0 ? (
          <div className="card" style={{ padding: 24 }}>
            <p style={{ margin: 0 }}>No hay citas próximas.</p>
            <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Cuando tu asistente agende, las verás aquí.</p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.day} style={{ marginBottom: 22 }}>
              <p className="display" style={{ fontSize: 15, margin: "0 0 10px", textTransform: "capitalize" }}>{g.day}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {g.items.map((a) => (
                  <div key={a.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ textAlign: "center", minWidth: 58 }}>
                      <p className="display" style={{ margin: 0, fontSize: 17 }}>{hhmm(a.startsAt)}</p>
                      <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>{hhmm(a.endsAt)}</p>
                    </div>
                    <div style={{ width: 3, alignSelf: "stretch", borderRadius: 3, background: STATUS_COLOR[a.status] ?? "var(--acc)" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{a.contact.name}</p>
                      <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                        {[a.serviceName, a.professionalName].filter(Boolean).join(" · ") || "Cita"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </main>
    </AppShell>
  );
}
