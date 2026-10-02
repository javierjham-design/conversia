"use client";
import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api, getToken } from "@/lib/api";

type Entry = { id: string; type: string; method: string; amount: number; status: string; concept: string | null; createdAt: string };
type Summary = { net: number; conciliado: number; declarado: number; efectivo: number; byMethod: Record<string, number>; count: number };
type Day = { from: string; to: string; summary: Summary; entries: Entry[]; closed: boolean; closure: { difference: number; declaredCash: number; calculatedCash: number } | null };

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const METHODS = [
  { v: "efectivo", l: "Efectivo" },
  { v: "transferencia", l: "Transferencia" },
  { v: "tarjeta", l: "Tarjeta (presencial)" },
  { v: "otro", l: "Otro" },
];
const METHOD_LABEL: Record<string, string> = { link_flow: "Link Flow", link_getnet: "Link Getnet", efectivo: "Efectivo", transferencia: "Transferencia", tarjeta: "Tarjeta", otro: "Otro" };
const clp = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("es-CL");

export default function Caja() {
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Form nuevo asiento
  const [type, setType] = useState<"ingreso" | "egreso">("ingreso");
  const [method, setMethod] = useState("efectivo");
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  // Cierre
  const [declaredCash, setDeclaredCash] = useState("");

  const load = useCallback(() => {
    api<Day>("/cash/day").then(setDay).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function addEntry(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError("Monto inválido"); return; }
    setBusy(true); setError(null); setMsg(null);
    try {
      await api("/cash/entry", { method: "POST", body: JSON.stringify({ type, method, amount: Math.round(amt), concept: concept.trim() || undefined, idempotencyKey: `ui-${Date.now()}` }) });
      setAmount(""); setConcept("");
      setMsg(type === "ingreso" ? "Ingreso registrado." : "Egreso registrado.");
      load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function reverse(id: string) {
    if (!confirm("¿Reversar este asiento? Se crea un asiento de reversa (el original no se borra).")) return;
    setBusy(true); setError(null);
    try { await api(`/cash/reverse`, { method: "POST", body: JSON.stringify({ entryId: id }) }); load(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function closeDay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api<{ closure: { difference: number } }>("/cash/close", { method: "POST", body: JSON.stringify({ declaredCash: Math.round(Number(declaredCash) || 0) }) });
      setMsg(`Caja cerrada. Diferencia: ${clp(r.closure.difference)}.`);
      setDeclaredCash("");
      load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function exportCsv() {
    const res = await fetch(`${API}/cash/export?range=month`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
    if (!res.ok) { setError("No se pudo exportar."); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "caja.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const s = day?.summary;

  return (
    <AppShell>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <h1 className="display" style={{ fontSize: 28, margin: 0 }}>Caja</h1>
          <button onClick={exportCsv} className="nav-item" style={{ marginLeft: "auto", width: "auto", height: 36, padding: "0 12px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13 }}>Exportar CSV</button>
        </div>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>El dinero que entra y sale de tu negocio hoy. (Esto es TU caja, distinta de tu plan Conversia.)</p>
        {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}
        {msg ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{msg}</p> : null}

        {s ? (
          <div className="card" style={{ padding: 20, marginBottom: 16 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>Total del día</p>
            <p className="display" style={{ margin: "4px 0 10px", fontSize: 34 }}>{clp(s.net)}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(s.byMethod).map(([m, v]) => (
                <span key={m} className="text-dim" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>{METHOD_LABEL[m] ?? m}: {clp(v)}</span>
              ))}
            </div>
            <p className="text-dim" style={{ fontSize: 12, marginTop: 10 }}>Conciliado (webhook): {clp(s.conciliado)} · Declarado (manual): {clp(s.declarado)} · Efectivo: {clp(s.efectivo)}{day?.closed ? " · 🔒 caja cerrada" : ""}</p>
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
          <form onSubmit={addEntry} className="card" style={{ padding: 18 }}>
            <h2 className="display" style={{ fontSize: 17, margin: "0 0 10px" }}>Registrar movimiento</h2>
            <div style={{ display: "flex", gap: 6 }}>
              {(["ingreso", "egreso"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setType(t)} style={{ flex: 1, padding: "8px", borderRadius: 10, cursor: "pointer", border: type === t ? "none" : "1px solid var(--line)", background: type === t ? (t === "ingreso" ? "var(--ok)" : "var(--danger)") : "transparent", color: type === t ? "#fff" : "var(--ink-dim)", fontWeight: 600, fontSize: 14 }}>{t === "ingreso" ? "Ingreso" : "Egreso"}</button>
              ))}
            </div>
            <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 }}>Monto (CLP)
              <input style={field} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="40000" />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 10 }}>Método
              <select style={field} value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select>
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 10 }}>Concepto (opcional)
              <input style={field} value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Corte + barba / compra insumos" />
            </label>
            <button className="btn-accent" type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, opacity: busy ? 0.6 : 1 }}>Registrar</button>
          </form>

          <form onSubmit={closeDay} className="card" style={{ padding: 18 }}>
            <h2 className="display" style={{ fontSize: 17, margin: "0 0 10px" }}>Cierre de caja</h2>
            <p className="text-dim" style={{ fontSize: 13, margin: "0 0 6px" }}>Cuenta el efectivo en caja y ciérrala. Comparamos con lo esperado.</p>
            <p className="text-dim" style={{ fontSize: 12 }}>Efectivo esperado (libro): <b>{s ? clp(s.efectivo) : "—"}</b></p>
            <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 10 }}>Efectivo contado (CLP)
              <input style={field} inputMode="numeric" value={declaredCash} onChange={(e) => setDeclaredCash(e.target.value)} placeholder="30000" />
            </label>
            <button className="btn-accent" type="submit" disabled={busy || !declaredCash} style={{ width: "100%", marginTop: 14, opacity: busy || !declaredCash ? 0.5 : 1 }}>Cerrar caja del día</button>
            {day?.closure ? <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>Último cierre: diferencia {clp(day.closure.difference)} (contado {clp(day.closure.declaredCash)} vs libro {clp(day.closure.calculatedCash)}).</p> : null}
          </form>
        </div>

        <h2 className="display" style={{ fontSize: 17, margin: "24px 0 10px" }}>Movimientos de hoy</h2>
        {day && day.entries.length === 0 ? (
          <div className="card" style={{ padding: 20 }}><p className="text-dim" style={{ margin: 0, fontSize: 14 }}>Aún no hay movimientos hoy.</p></div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {day?.entries.map((e) => (
              <div key={e.id} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: e.amount < 0 ? "var(--danger)" : "var(--ok)", minWidth: 96 }}>{clp(e.amount)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13 }}>{e.concept || (e.type === "reversa" ? "Reversa" : e.type)}</span>
                  <br /><span className="text-dim" style={{ fontSize: 11 }}>{METHOD_LABEL[e.method] ?? e.method} · {e.status === "conciliado" ? "conciliado" : "declarado"} · {new Date(e.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                {e.type !== "reversa" ? (
                  <button onClick={() => reverse(e.id)} title="Reversar" className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer" }}><RotateCcw size={15} /></button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}
