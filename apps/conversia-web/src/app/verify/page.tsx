"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Confirma el correo con el token del link (D6). Público: funciona con o sin sesión. */
export default function Verify() {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("error");
      setMsg("Falta el token del enlace.");
      return;
    }
    api("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setState("ok"))
      .catch((e) => {
        setState("error");
        setMsg((e as Error).message);
      });
  }, []);

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 420, padding: 32, textAlign: "center" }}>
        {state === "loading" ? (
          <p className="text-dim">Verificando tu correo…</p>
        ) : state === "ok" ? (
          <>
            <p style={{ fontSize: 40, margin: 0 }}>✅</p>
            <h1 className="display" style={{ fontSize: 24, margin: "10px 0 6px" }}>Correo confirmado</h1>
            <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tu cuenta quedó verificada. Ya puedes usar Conversia con todo activo.</p>
            <a className="btn-accent" href="/" style={{ textDecoration: "none", display: "inline-block" }}>Ir a mi panel</a>
          </>
        ) : (
          <>
            <p style={{ fontSize: 40, margin: 0 }}>⚠️</p>
            <h1 className="display" style={{ fontSize: 22, margin: "10px 0 6px" }}>No se pudo verificar</h1>
            <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>{msg || "El enlace no es válido o venció."}</p>
            <a className="btn-accent" href="/" style={{ textDecoration: "none", display: "inline-block" }}>Ir a mi panel</a>
          </>
        )}
      </div>
    </main>
  );
}
