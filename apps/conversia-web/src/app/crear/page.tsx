"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Send, Sparkles } from "lucide-react";

// V2-3 — Generador público (/crear): el producto en la portada. Rubro + nombre + web/IG →
// construcción narrada → simulador de WhatsApp jugable (sin cuenta) → registro para GUARDAR.
// Público (sin auth): habla directo a la API con fetch.

import { apiBase } from "@/lib/api-base";
const API = apiBase();

type Vertical = { key: string; name: string; emoji: string; tagline: string };
type Msg = { role: "user" | "assistant"; content: string };

export default function Crear() {
  const [stage, setStage] = useState<"form" | "building" | "sim">("form");
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [vertical, setVertical] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // draft + simulador
  const [token, setToken] = useState<string | null>(null);
  const [verticalName, setVerticalName] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draftReply, setDraftReply] = useState("");
  const [sending, setSending] = useState(false);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(15);
  const bottom = useRef<HTMLDivElement>(null);

  // Carga de rubros con ERROR VISIBLE y reintento (antes un fallo dejaba
  // "Cargando rubros…" para siempre — hallazgo prod 17-oct-2026).
  const [verticalsError, setVerticalsError] = useState(false);
  const loadVerticals = useCallback(() => {
    setVerticalsError(false);
    fetch(`${API}/public/verticals`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((v) => { if (Array.isArray(v) && v.length) setVerticals(v); else setVerticalsError(true); })
      .catch(() => setVerticalsError(true));
  }, []);
  useEffect(() => { loadVerticals(); }, [loadVerticals]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  // Animación de construcción narrada → arranca el simulador con el saludo del bot.
  useEffect(() => {
    if (stage !== "building" || !steps.length) return;
    if (stepIdx >= steps.length) {
      const t = setTimeout(() => {
        setStage("sim");
        setMsgs([{ role: "assistant", content: `¡Hola! Soy el asistente de ${name}. ¿En qué te puedo ayudar? Puedo contarte de los servicios o agendarte una hora.` }]);
      }, 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStepIdx((i) => i + 1), 900);
    return () => clearTimeout(t);
  }, [stage, steps, stepIdx, name]);

  async function createDraft() {
    setErr(null);
    if (!vertical || name.trim().length < 2) { setErr("Elige un rubro y escribe el nombre de tu negocio."); return; }
    setStage("building");
    setStepIdx(0);
    try {
      const r = await fetch(`${API}/public/crear/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vertical, businessName: name.trim(), website: website.trim() || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "No se pudo crear el asistente.");
      const d = await r.json();
      setToken(d.token);
      setVerticalName(d.verticalName);
      setSteps(d.steps ?? ["Configurando tu asistente…", "Listo."]);
    } catch (e) {
      setErr((e as Error).message);
      setStage("form");
    }
  }

  async function send() {
    const text = draftReply.trim();
    if (!text || !token || sending || used >= limit) return;
    setSending(true);
    const history = [...msgs, { role: "user" as const, content: text }];
    setMsgs(history);
    setDraftReply("");
    try {
      const r = await fetch(`${API}/public/crear/${token}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history }),
      });
      const d = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: d.reply ?? "…" }]);
      if (typeof d.messagesUsed === "number") setUsed(d.messagesUsed);
      if (typeof d.messagesLimit === "number") setLimit(d.messagesLimit);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "No pude responder ahora. Crea tu cuenta y tu asistente quedará listo." }]);
    } finally {
      setSending(false);
    }
  }

  const registerHref = token ? `/registro?draftToken=${encodeURIComponent(token)}&vertical=${encodeURIComponent(vertical)}` : "/registro";

  return (
    <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 18px 60px" }}>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 6 }}>
          <Sparkles size={18} style={{ color: "var(--acc)" }} />
          <span className="text-dim" style={{ fontSize: 13, letterSpacing: 0.3 }}>Conversia</span>
        </div>
        <h1 className="display" style={{ fontSize: 30, textAlign: "center", margin: "0 0 8px", lineHeight: 1.15 }}>
          Tu recepcionista IA, <span style={{ color: "var(--acc-deep)" }}>armado solo</span>
        </h1>
        <p className="text-dim" style={{ textAlign: "center", fontSize: 15, margin: "0 0 24px" }}>Pruébalo en 60 segundos. Sin cuenta, sin tarjeta.</p>

        {/* FORM */}
        {stage === "form" ? (
          <div className="card" style={{ padding: 22 }}>
            <label style={{ fontSize: 13, color: "var(--ink-dim)" }}>¿Qué tipo de negocio tienes?</label>
            {/* Con pocos rubros: chips (lindos para marketing). Con el catálogo completo
                (>8, hoy 14): lista desplegable — los chips desbordaban la tarjeta
                (pedido de Javier, 17-oct-2026). */}
            <div style={{ margin: "10px 0 18px" }}>
              {verticals.length > 0 && verticals.length <= 8 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {verticals.map((v) => (
                    <button key={v.key} onClick={() => setVertical(v.key)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, cursor: "pointer", fontSize: 14, border: vertical === v.key ? "none" : "1px solid var(--line)", background: vertical === v.key ? "var(--acc)" : "transparent", color: vertical === v.key ? "var(--acc-ink)" : "var(--ink)" }}>
                      <span>{v.emoji}</span> {v.name}
                    </button>
                  ))}
                </div>
              ) : null}
              {verticals.length > 8 ? (
                <select
                  value={vertical}
                  onChange={(e) => setVertical(e.target.value)}
                  style={{ ...field, marginTop: 0, cursor: "pointer", appearance: "auto" as const }}
                  aria-label="Elige tu rubro"
                >
                  <option value="" disabled>Elige tu rubro…</option>
                  {verticals.map((v) => (
                    <option key={v.key} value={v.key}>{v.emoji} {v.name} — {v.tagline}</option>
                  ))}
                </select>
              ) : null}
              {verticals.length === 0 && !verticalsError ? <span className="text-dim" style={{ fontSize: 13 }}>Cargando rubros…</span> : null}
              {verticalsError ? (
                <span style={{ fontSize: 13, color: "var(--danger)" }}>
                  No pudimos cargar los rubros.{" "}
                  <button onClick={loadVerticals} style={{ background: "none", border: "none", color: "var(--acc)", cursor: "pointer", fontSize: 13, padding: 0, textDecoration: "underline" }}>Reintentar</button>
                </span>
              ) : null}
            </div>
            <label style={{ fontSize: 13, color: "var(--ink-dim)", display: "block" }}>Nombre de tu negocio
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Barbería Estilo" style={field} />
            </label>
            <label style={{ fontSize: 13, color: "var(--ink-dim)", display: "block", marginTop: 12 }}>Tu web o Instagram (opcional)
              <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="instagram.com/tunegocio" style={field} />
            </label>
            {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
            <button className="btn-accent" onClick={createDraft} style={{ width: "100%", marginTop: 20, padding: "13px", fontSize: 15, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              Crear mi asistente <ArrowRight size={18} />
            </button>
          </div>
        ) : null}

        {/* BUILDING */}
        {stage === "building" ? (
          <div className="card" style={{ padding: 28 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {steps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, opacity: i <= stepIdx ? 1 : 0.35, transition: "opacity .3s" }}>
                  <span style={{ width: 20, height: 20, borderRadius: "50%", display: "grid", placeItems: "center", background: i < stepIdx ? "var(--ok)" : "var(--acc-dim)", color: i < stepIdx ? "#fff" : "var(--acc-deep)", fontSize: 12, flexShrink: 0 }}>{i < stepIdx ? "✓" : i + 1}</span>
                  <span style={{ fontSize: 14 }}>{s}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* SIMULADOR estilo WhatsApp */}
        {stage === "sim" ? (
          <div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline)", display: "flex", alignItems: "center", gap: 10, background: "var(--surface-solid)" }}>
                <span style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontWeight: 700 }}>{name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <b style={{ fontSize: 14, display: "block" }}>{name}</b>
                  <span className="text-dim" style={{ fontSize: 11 }}>Demo · asistente de {verticalName}</span>
                </div>
              </div>
              <div style={{ height: 360, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "color-mix(in srgb, var(--acc) 4%, var(--surface-solid))" }}>
                {msgs.map((m, i) => (
                  <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "80%", padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", background: m.role === "user" ? "var(--acc)" : "var(--surface-solid)", color: m.role === "user" ? "var(--acc-ink)" : "var(--ink)", border: m.role === "assistant" ? "1px solid var(--hairline)" : "none" }}>{m.content}</div>
                ))}
                {sending ? <div className="text-dim" style={{ fontSize: 12, alignSelf: "flex-start" }}>escribiendo…</div> : null}
                <div ref={bottom} />
              </div>
              <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid var(--hairline)", alignItems: "center" }}>
                <input value={draftReply} onChange={(e) => setDraftReply(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} disabled={used >= limit} placeholder={used >= limit ? "Crea tu cuenta para seguir…" : "Escribe como si fueras un cliente…"} style={{ flex: 1, padding: "11px 14px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
                <button className="btn-accent" onClick={send} disabled={sending || !draftReply.trim() || used >= limit} style={{ borderRadius: "50%", width: 42, height: 42, display: "grid", placeItems: "center", flexShrink: 0, opacity: sending || !draftReply.trim() || used >= limit ? 0.5 : 1 }}><Send size={17} /></button>
              </div>
            </div>
            <p className="text-dim" style={{ textAlign: "center", fontSize: 12, margin: "10px 0 14px" }}>Demo — crea tu cuenta para guardarlo ({used}/{limit} mensajes de prueba)</p>
            <a href={registerHref} className="btn-accent" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px", fontSize: 15, textDecoration: "none" }}>
              Crear mi cuenta gratis — 30 conversaciones de regalo <ArrowRight size={18} />
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}

const field: React.CSSProperties = { width: "100%", padding: "11px 13px", marginTop: 6, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
