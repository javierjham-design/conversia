"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Globe, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

/* PELDAÑO 3 — editor del mini-sitio público (conversia.cl/n/<slug>). El dueño publica una
 * página simple de su negocio en <1 min: el resto se arma solo (nombre, servicios, número
 * de WhatsApp conectado). Lee/escribe GET|PUT /settings/mini-site. */

type MiniSiteCfg = {
  enabled: boolean;
  slug: string;
  tagline: string;
  about: string;
  hours: string;
  address: string;
  instagram: string;
  whatsapp: string;
  waText: string;
  showServices: boolean;
  derived: { name: string; whatsappConnected: string | null; serviceCount: number; industry: string };
};

export default function MiniSitio() {
  const [cfg, setCfg] = useState<MiniSiteCfg | null>(null);
  const [saving, setSaving] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<MiniSiteCfg>("/settings/mini-site").then(setCfg).catch(() => setErr("No se pudo cargar tu mini-sitio."));
  }, []);

  function set<K extends keyof MiniSiteCfg>(key: K, value: MiniSiteCfg[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  async function save(nextEnabled?: boolean) {
    if (!cfg) return;
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      const enabled = nextEnabled ?? cfg.enabled;
      await api("/settings/mini-site", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          tagline: cfg.tagline, about: cfg.about, hours: cfg.hours,
          address: cfg.address, instagram: cfg.instagram, whatsapp: cfg.whatsapp, waText: cfg.waText,
          showServices: cfg.showServices,
        }),
      });
      set("enabled", enabled);
      setOkMsg(enabled ? "¡Publicado! Tu página ya está en línea." : "Guardado. Tu página está despublicada.");
    } catch (e) {
      setErr((e as Error).message || "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  }

  const publicUrl = cfg ? `https://conversia.cl/n/${cfg.slug}` : "";
  const appPath = cfg ? `/n/${cfg.slug}` : "";

  return (
    <AppShell>
      <main style={{ maxWidth: 680, margin: "0 auto", padding: "28px 20px 44px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Tu página web</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 22px" }}>Una página simple de tu negocio, con botón de WhatsApp. Se arma sola; tú solo ajustas unos textos y la publicas.</p>

        {okMsg ? (
          <div className="card" style={{ padding: 13, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", borderColor: "var(--ok)" }}>
            <CheckCircle2 size={18} style={{ color: "var(--ok)", flexShrink: 0 }} /><span style={{ fontSize: 14 }}>{okMsg}</span>
          </div>
        ) : null}
        {err ? (
          <div className="card" style={{ padding: 13, marginBottom: 16, fontSize: 14, color: "var(--warn)" }}>{err}</div>
        ) : null}

        {!cfg && !err ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-dim)" }}><Loader2 size={16} className="lp-spin" /> Cargando…</div>
        ) : !cfg ? null : (
          <>
            {/* Estado + enlace */}
            <div className="card" style={{ padding: 18, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 42, height: 42, borderRadius: 12, background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", flexShrink: 0 }}><Globe size={20} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{cfg.enabled ? "Tu página está publicada" : "Tu página no está publicada"}</p>
                  <a href={appPath} target="_blank" rel="noreferrer" style={{ margin: "2px 0 0", fontSize: 13, color: "var(--acc-deep)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    {publicUrl} <ExternalLink size={13} />
                  </a>
                </div>
                <button onClick={() => void save(!cfg.enabled)} disabled={saving} className={cfg.enabled ? "card" : "btn-accent"} style={{ border: cfg.enabled ? undefined : "none", cursor: "pointer", fontSize: 13.5, padding: "9px 16px", whiteSpace: "nowrap" }}>
                  {saving ? "…" : cfg.enabled ? "Despublicar" : "Publicar"}
                </button>
              </div>
              {!cfg.derived.whatsappConnected && !cfg.whatsapp ? (
                <p className="text-dim" style={{ margin: "12px 0 0", fontSize: 12.5 }}>Aún no tienes un WhatsApp conectado: conéctalo en <a href="/canales" style={{ color: "var(--acc-deep)" }}>Canales</a> o escribe un número abajo para que el botón funcione.</p>
              ) : null}
            </div>

            {/* Campos */}
            <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 15 }}>
              <Field label="Nombre del negocio" hint="Se toma de tu cuenta.">
                <input value={cfg.derived.name} disabled style={inp(true)} />
              </Field>
              <Field label="Frase corta (debajo del nombre)" hint="Ej: «Barbería clásica en el centro de Temuco».">
                <input value={cfg.tagline} maxLength={140} onChange={(e) => set("tagline", e.target.value)} style={inp()} placeholder="Una línea que diga a qué te dedicas" />
              </Field>
              <Field label="Descripción" hint="Un párrafo sobre tu negocio.">
                <textarea value={cfg.about} maxLength={1200} onChange={(e) => set("about", e.target.value)} rows={4} style={{ ...inp(), resize: "vertical", fontFamily: "inherit" }} placeholder="Qué ofreces, por qué elegirte…" />
              </Field>
              <Field label="Horarios" hint="Texto libre; una línea por día si quieres.">
                <textarea value={cfg.hours} maxLength={400} onChange={(e) => set("hours", e.target.value)} rows={3} style={{ ...inp(), resize: "vertical", fontFamily: "inherit" }} placeholder={"Lun a Vie 10:00–20:00\nSáb 10:00–14:00"} />
              </Field>
              <Field label="Dirección" hint="Dónde te encuentran (opcional).">
                <input value={cfg.address} maxLength={200} onChange={(e) => set("address", e.target.value)} style={inp()} placeholder="Calle 123, Temuco" />
              </Field>
              <Field label="Instagram" hint="Tu usuario (opcional).">
                <input value={cfg.instagram} maxLength={120} onChange={(e) => set("instagram", e.target.value)} style={inp()} placeholder="@tunegocio" />
              </Field>
              <Field label="WhatsApp del botón" hint={cfg.derived.whatsappConnected ? `Vacío = usa tu número conectado (${cfg.derived.whatsappConnected}).` : "Número con código de país, ej: +56 9 1234 5678."}>
                <input value={cfg.whatsapp} maxLength={30} onChange={(e) => set("whatsapp", e.target.value)} style={inp()} placeholder={cfg.derived.whatsappConnected ?? "+56 9 ..."} />
              </Field>
              <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, cursor: "pointer" }}>
                <input type="checkbox" checked={cfg.showServices} onChange={(e) => set("showServices", e.target.checked)} />
                Mostrar mis servicios y precios {cfg.derived.serviceCount > 0 ? `(${cfg.derived.serviceCount})` : "(aún no cargas servicios)"}
              </label>

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={() => void save()} disabled={saving} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 14, padding: "10px 20px", display: "inline-flex", alignItems: "center", gap: 7 }}>
                  {saving ? <Loader2 size={15} className="lp-spin" /> : null} Guardar cambios
                </button>
              </div>
            </div>
          </>
        )}
        <style>{`.lp-spin { animation: lpspin 1s linear infinite; } @keyframes lpspin { to { transform: rotate(360deg); } }`}</style>
      </main>
    </AppShell>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 5 }}>{label}</label>
      {children}
      {hint ? <p className="text-dim" style={{ margin: "5px 0 0", fontSize: 11.5 }}>{hint}</p> : null}
    </div>
  );
}

function inp(disabled = false): React.CSSProperties {
  return {
    width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid var(--line)",
    background: disabled ? "var(--line)" : "var(--bg)", color: "var(--ink)", fontSize: 14,
    opacity: disabled ? 0.7 : 1,
  };
}
