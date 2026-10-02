"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";

// Acento por país (espejo de accentForCountry en @conversia/config): da un preview
// inmediato al elegir país. El default real del acento lo fija el servidor por país.
const ACCENT_BY_COUNTRY: Record<string, string> = { CL: "menta", AR: "artico", CO: "oro", MX: "lima", PE: "coral" };
const COUNTRIES = [
  { code: "CL", label: "Chile" },
  { code: "AR", label: "Argentina" },
  { code: "CO", label: "Colombia" },
  { code: "MX", label: "México" },
  { code: "PE", label: "Perú" },
  { code: "ES", label: "España" },
  { code: "US", label: "Estados Unidos" },
];
const VERTICALS = [
  { key: "dental", emoji: "🦷", label: "Clínica dental", desc: "Odontología y consultas dentales" },
  { key: "centro_medico", emoji: "🩺", label: "Centro médico", desc: "Consultas y especialidades médicas" },
  { key: "estetica", emoji: "🌿", label: "Centro de estética", desc: "Faciales, corporales y depilación" },
  { key: "barberia", emoji: "💈", label: "Barbería", desc: "Cortes, barba y combos" },
  { key: "peluqueria", emoji: "✂️", label: "Peluquería", desc: "Corte, color, peinado y tratamientos" },
  { key: "generico", emoji: "✨", label: "Otro rubro", desc: "Configuración general lista para adaptar" },
];

export default function Register() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [organizationName, setOrg] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState("CL");
  const [vertical, setVertical] = useState("dental");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Autoservicio (D7): el bot comercial manda /registro?vertical=barberia → preselecciona
  // el rubro. También acepta ?country= para el acento/moneda.
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const v = qs.get("vertical");
    if (v && VERTICALS.some((x) => x.key === v)) setVertical(v);
    const c = qs.get("country")?.toUpperCase();
    if (c && COUNTRIES.some((x) => x.code === c)) {
      setCountry(c);
      const acc = ACCENT_BY_COUNTRY[c] ?? "indigo";
      document.documentElement.setAttribute("data-accent", acc);
      try {
        localStorage.setItem("conversia_accent", acc);
      } catch {}
    }
  }, []);

  function chooseCountry(code: string) {
    setCountry(code);
    const acc = ACCENT_BY_COUNTRY[code] ?? "indigo";
    document.documentElement.setAttribute("data-accent", acc);
    try {
      localStorage.setItem("conversia_accent", acc);
    } catch {}
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ name, organizationName, email, password, country, vertical }),
      });
      setToken(res.token);
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "11px 13px", marginTop: 6, borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 15 };
  const label: React.CSSProperties = { fontSize: 13, color: "var(--ink-dim)", display: "block", marginTop: 14 };

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 480, padding: 28 }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 20px" }}>
          Crea tu <span className="display-italic">cuenta</span>
        </h1>

        <label style={{ ...label, marginTop: 0 }}>Tu nombre
          <input style={field} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoComplete="name" />
        </label>
        <label style={label}>Nombre del negocio
          <input style={field} value={organizationName} onChange={(e) => setOrg(e.target.value)} required minLength={2} />
        </label>
        <label style={label}>Correo
          <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label style={label}>Contraseña (mínimo 10)
          <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
        </label>
        <label style={label}>País
          <select style={field} value={country} onChange={(e) => chooseCountry(e.target.value)}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </label>

        <p style={{ ...label, marginBottom: 2 }}>¿Cuál es tu rubro?</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
          {VERTICALS.map((v) => {
            const on = vertical === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setVertical(v.key)}
                style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: "12px 14px", borderRadius: 14, cursor: "pointer", border: on ? "none" : "1px solid var(--line)", background: on ? "var(--acc-dim)" : "transparent", boxShadow: on ? "inset 0 0 0 2px var(--acc)" : "none" }}
              >
                <span style={{ fontSize: 24 }}>{v.emoji}</span>
                <span>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 14, color: on ? "var(--acc-deep)" : "var(--ink)" }}>{v.label}</span>
                  <span className="text-dim" style={{ fontSize: 12 }}>{v.desc}</span>
                </span>
              </button>
            );
          })}
        </div>

        {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 14 }}>{error}</p> : null}
        <button className="btn-accent" type="submit" disabled={loading} style={{ width: "100%", marginTop: 20, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Creando…" : "Crear cuenta"}
        </button>
        <p className="text-dim" style={{ fontSize: 13, textAlign: "center", marginTop: 16 }}>
          ¿Ya tienes cuenta? <a href="/login" className="text-accent" style={{ textDecoration: "none" }}>Entrar</a>
        </p>
      </form>
    </main>
  );
}
