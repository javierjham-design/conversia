"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Trash2, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Block = { day: number; start: string; end: string };
type Pro = { id: string; name: string; specialty: string | null; type: "persona" | "servicio"; durationMin: number | null; workingHours: Block[] };
type Svc = { id: string; code: string; name: string; durationMin: number; price: number | null };
type Config = { slotStepMin: number; bufferMin: number; minAdvanceMin: number };

const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const FIELD: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
const LBL: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 };

export default function ConfigurarAgenda() {
  const [pros, setPros] = useState<Pro[]>([]);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [editingPro, setEditingPro] = useState<Pro | "new" | null>(null);
  const [editingSvc, setEditingSvc] = useState<Svc | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);

  function loadAll() {
    api<Pro[]>("/agenda/professionals").then(setPros).catch((e) => setError((e as Error).message));
    api<Svc[]>("/agenda/services").then(setSvcs).catch(() => {});
    api<Config>("/agenda/config").then(setCfg).catch(() => {});
  }
  useEffect(loadAll, []);

  async function saveCfg(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    setCfgMsg(null);
    try {
      await api("/agenda/config", { method: "PUT", body: JSON.stringify(cfg) });
      setCfgMsg("Guardado.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deletePro(id: string) {
    if (!confirm("¿Desactivar este recurso?")) return;
    await api(`/agenda/professionals/${id}`, { method: "DELETE" }).catch((e) => setError((e as Error).message));
    loadAll();
  }
  async function deleteSvc(id: string) {
    if (!confirm("¿Desactivar este servicio?")) return;
    await api(`/agenda/services/${id}`, { method: "DELETE" }).catch((e) => setError((e as Error).message));
    loadAll();
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 40px" }}>
        <a href="/agenda" className="text-dim" style={{ fontSize: 13, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}><ArrowLeft size={14} /> Agenda</a>
        <h1 className="display" style={{ fontSize: 28, margin: "8px 0 20px" }}>Configurar agenda</h1>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {/* Reglas */}
        {cfg ? (
          <form onSubmit={saveCfg} className="card" style={{ padding: 20, marginBottom: 16 }}>
            <h2 className="display" style={{ fontSize: 17, margin: "0 0 12px" }}>Reglas de reserva</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Bloque (min)
                <input style={FIELD} type="number" min={5} max={240} value={cfg.slotStepMin} onChange={(e) => setCfg({ ...cfg, slotStepMin: Number(e.target.value) })} />
              </label>
              <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Descanso entre citas (min)
                <input style={FIELD} type="number" min={0} max={240} value={cfg.bufferMin} onChange={(e) => setCfg({ ...cfg, bufferMin: Number(e.target.value) })} />
              </label>
              <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Antelación mínima (min)
                <input style={FIELD} type="number" min={0} max={20160} value={cfg.minAdvanceMin} onChange={(e) => setCfg({ ...cfg, minAdvanceMin: Number(e.target.value) })} />
              </label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
              <button className="btn-accent" type="submit">Guardar reglas</button>
              {cfgMsg ? <span style={{ color: "var(--ok)", fontSize: 13 }}>{cfgMsg}</span> : null}
            </div>
          </form>
        ) : null}

        {/* Equipo / recursos */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
          <h2 className="display" style={{ fontSize: 18, margin: 0 }}>Equipo y recursos</h2>
          <button className="btn-accent" onClick={() => setEditingPro("new")} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={16} /> Agregar</button>
        </div>
        {pros.length === 0 ? (
          <div className="card" style={{ padding: 20 }}><p className="text-dim" style={{ margin: 0, fontSize: 14 }}>Sin recursos. Agrega personas (dentista, barbero…) o recursos (box, sillón) con sus horarios.</p></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pros.map((p) => (
              <div key={p.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{p.name} <span className="text-dim" style={{ fontSize: 12, fontWeight: 400 }}>· {p.type}{p.specialty ? ` · ${p.specialty}` : ""}</span></p>
                  <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    {p.workingHours.length ? p.workingHours.map((b) => `${DAYS[b.day]} ${b.start}-${b.end}`).join(" · ") : "Sin horario definido"}
                  </p>
                </div>
                <button onClick={() => setEditingPro(p)} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>Editar</button>
                <button onClick={() => deletePro(p.id)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Desactivar"><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Servicios */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
          <h2 className="display" style={{ fontSize: 18, margin: 0 }}>Servicios</h2>
          <button className="btn-accent" onClick={() => setEditingSvc("new")} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}><Plus size={16} /> Agregar</button>
        </div>
        {svcs.length === 0 ? (
          <div className="card" style={{ padding: 20 }}><p className="text-dim" style={{ margin: 0, fontSize: 14 }}>Sin servicios. Agrega los que ofreces (consulta, corte…) con su duración.</p></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {svcs.map((sv) => (
              <div key={sv.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{sv.name}</p>
                  <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{sv.durationMin} min{sv.price != null ? ` · $${sv.price.toLocaleString("es-CL")}` : ""}</p>
                </div>
                <button onClick={() => setEditingSvc(sv)} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>Editar</button>
                <button onClick={() => deleteSvc(sv.id)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Desactivar"><Trash2 size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </main>

      {editingPro ? <ProForm pro={editingPro === "new" ? null : editingPro} onClose={() => setEditingPro(null)} onSaved={() => { setEditingPro(null); loadAll(); }} /> : null}
      {editingSvc ? <SvcForm svc={editingSvc === "new" ? null : editingSvc} onClose={() => setEditingSvc(null)} onSaved={() => { setEditingSvc(null); loadAll(); }} /> : null}
    </AppShell>
  );
}

function ProForm({ pro, onClose, onSaved }: { pro: Pro | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(pro?.name ?? "");
  const [type, setType] = useState<"persona" | "servicio">(pro?.type ?? "persona");
  const [specialty, setSpecialty] = useState(pro?.specialty ?? "");
  const [durationMin, setDurationMin] = useState(pro?.durationMin ? String(pro.durationMin) : "");
  const [hours, setHours] = useState<Block[]>(pro?.workingHours ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addBlock() {
    setHours((h) => [...h, { day: 1, start: "09:00", end: "18:00" }]);
  }
  function setBlock(i: number, patch: Partial<Block>) {
    setHours((h) => h.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeBlock(i: number) {
    setHours((h) => h.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 1) {
      setErr("El nombre es obligatorio.");
      return;
    }
    setBusy(true);
    setErr(null);
    const payload = {
      name: name.trim(),
      type,
      specialty: specialty.trim() || undefined,
      durationMin: durationMin ? Number(durationMin) : undefined,
      workingHours: hours,
    };
    try {
      if (pro) await api(`/agenda/professionals/${pro.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/agenda/professionals", { method: "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 460, padding: 22, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>{pro ? "Editar recurso" : "Nuevo recurso"}</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <label style={LBL}>Nombre
          <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Dra. Ana / Box 1" />
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...LBL, flex: 1 }}>Tipo
            <select style={FIELD} value={type} onChange={(e) => setType(e.target.value as "persona" | "servicio")}>
              <option value="persona">Persona</option>
              <option value="servicio">Recurso</option>
            </select>
          </label>
          <label style={{ ...LBL, flex: 1 }}>Duración por defecto (min)
            <input style={FIELD} type="number" min={5} max={1440} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} placeholder="30" />
          </label>
        </div>
        <label style={LBL}>Especialidad (opcional)
          <input style={FIELD} value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Ortodoncia" />
        </label>

        <p style={{ ...LBL, marginBottom: 2 }}>Horario de atención</p>
        {hours.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
            <select value={b.day} onChange={(e) => setBlock(i, { day: Number(e.target.value) })} style={{ ...FIELD, marginTop: 0, flex: "0 0 92px" }}>
              {DAYS.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
            </select>
            <input type="time" value={b.start} onChange={(e) => setBlock(i, { start: e.target.value })} style={{ ...FIELD, marginTop: 0 }} />
            <span className="text-dim">–</span>
            <input type="time" value={b.end} onChange={(e) => setBlock(i, { end: e.target.value })} style={{ ...FIELD, marginTop: 0 }} />
            <button type="button" onClick={() => removeBlock(i)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Quitar"><Trash2 size={15} /></button>
          </div>
        ))}
        <button type="button" onClick={addBlock} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, marginTop: 8, display: "inline-flex", alignItems: "center", gap: 4 }}><Plus size={14} /> Añadir bloque</button>

        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" type="submit" disabled={busy} style={{ width: "100%", marginTop: 16, opacity: busy ? 0.6 : 1 }}>{busy ? "Guardando…" : "Guardar"}</button>
      </form>
    </div>
  );
}

function SvcForm({ svc, onClose, onSaved }: { svc: Svc | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(svc?.name ?? "");
  const [durationMin, setDurationMin] = useState(svc ? String(svc.durationMin) : "30");
  const [price, setPrice] = useState(svc?.price != null ? String(svc.price) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 1 || !durationMin) {
      setErr("Nombre y duración son obligatorios.");
      return;
    }
    setBusy(true);
    setErr(null);
    const payload = { name: name.trim(), durationMin: Number(durationMin), price: price ? Number(price) : undefined };
    try {
      if (svc) await api(`/agenda/services/${svc.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/agenda/services", { method: "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 400, padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>{svc ? "Editar servicio" : "Nuevo servicio"}</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <label style={LBL}>Nombre
          <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Consulta / Corte" />
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...LBL, flex: 1 }}>Duración (min)
            <input style={FIELD} type="number" min={5} max={1440} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
          </label>
          <label style={{ ...LBL, flex: 1 }}>Precio (opcional)
            <input style={FIELD} type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
          </label>
        </div>
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" type="submit" disabled={busy} style={{ width: "100%", marginTop: 16, opacity: busy ? 0.6 : 1 }}>{busy ? "Guardando…" : "Guardar"}</button>
      </form>
    </div>
  );
}
