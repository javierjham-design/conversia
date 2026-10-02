"use client";
import { useEffect, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

const ACCENTS: { key: string; label: string; color: string }[] = [
  { key: "menta", label: "Menta", color: "#2dd4bf" },
  { key: "artico", label: "Ártico", color: "#38bdf8" },
  { key: "indigo", label: "Índigo", color: "#818cf8" },
  { key: "lima", label: "Lima", color: "#a3e635" },
  { key: "oro", label: "Oro", color: "#fbbf24" },
  { key: "coral", label: "Coral", color: "#fb7185" },
];

type Me = { user: { name: string | null; email: string; settings?: { accent?: string } | null } };

function applyTheme(t: string) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("conversia_theme", t);
}
function applyAccent(a: string) {
  document.documentElement.setAttribute("data-accent", a);
  localStorage.setItem("conversia_accent", a);
}

export default function Ajustes() {
  const [theme, setTheme] = useState("dark");
  const [accent, setAccent] = useState("menta");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedName, setSavedName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTheme(localStorage.getItem("conversia_theme") || "dark");
    setAccent(localStorage.getItem("conversia_accent") || "menta");
    api<Me>("/auth/me")
      .then((me) => {
        setName(me.user.name ?? "");
        setSavedName(me.user.name ?? "");
        setEmail(me.user.email);
        // Hidrata el acento desde el servidor (cross-dispositivo) si existe.
        const serverAccent = me.user.settings?.accent;
        if (serverAccent && ACCENTS.some((a) => a.key === serverAccent)) {
          setAccent(serverAccent);
          applyAccent(serverAccent);
        }
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  function chooseTheme(t: string) {
    setTheme(t);
    applyTheme(t);
  }

  async function chooseAccent(a: string) {
    setAccent(a);
    applyAccent(a);
    setMsg(null);
    try {
      await api("/auth/me/preferences", { method: "PATCH", body: JSON.stringify({ accent: a }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await api("/auth/me", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      setSavedName(name.trim());
      setMsg("Perfil actualizado.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const modeBtn = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    borderRadius: 12,
    cursor: "pointer",
    fontSize: 14,
    border: active ? "none" : "1px solid var(--line)",
    background: active ? "var(--acc)" : "transparent",
    color: active ? "var(--acc-ink)" : "var(--ink)",
    fontWeight: active ? 600 : 400,
  });

  return (
    <AppShell>
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 20px" }}>Ajustes</h1>
        {msg ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{msg}</p> : null}
        {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

        <div className="card" style={{ padding: 20, marginBottom: 16 }}>
          <h2 className="display" style={{ fontSize: 18, margin: "0 0 14px" }}>Apariencia</h2>
          <p className="text-dim" style={{ fontSize: 13, margin: "0 0 8px" }}>Modo</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => chooseTheme("dark")} style={modeBtn(theme === "dark")}><Moon size={16} /> Oscuro</button>
            <button onClick={() => chooseTheme("light")} style={modeBtn(theme === "light")}><Sun size={16} /> Claro</button>
          </div>

          <p className="text-dim" style={{ fontSize: 13, margin: "18px 0 8px" }}>Acento</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                onClick={() => chooseAccent(a.key)}
                title={a.label}
                aria-label={a.label}
                style={{ width: 42, height: 42, borderRadius: "50%", background: a.color, border: accent === a.key ? "3px solid var(--ink)" : "3px solid transparent", cursor: "pointer", display: "grid", placeItems: "center" }}
              >
                {accent === a.key ? <Check size={18} color="#04221e" /> : null}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={saveName} className="card" style={{ padding: 20 }}>
          <h2 className="display" style={{ fontSize: 18, margin: "0 0 14px" }}>Perfil</h2>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>
            Nombre
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "10px 13px", marginTop: 6, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 }}>
            Correo
            <input value={email} disabled style={{ width: "100%", padding: "10px 13px", marginTop: 6, borderRadius: 10, border: "1px solid var(--line)", background: "var(--bg-tint)", color: "var(--ink-dim)", fontSize: 14 }} />
          </label>
          <button className="btn-accent" type="submit" disabled={name.trim().length < 2 || name.trim() === savedName} style={{ marginTop: 16, opacity: name.trim().length < 2 || name.trim() === savedName ? 0.5 : 1 }}>
            Guardar
          </button>
        </form>
      </main>
    </AppShell>
  );
}
