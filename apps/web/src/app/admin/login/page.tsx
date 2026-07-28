"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { API_URL, setPlatformToken } from "@/lib/platform-api";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Fetch directo (no `padmin`) para poder leer el flag `mfaRequired` del 401.
      const res = await fetch(`${API_URL}/platform/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, code: code || undefined }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (res.ok) {
        setPlatformToken(body.token);
        router.push("/admin");
        return;
      }
      if (body.mfaRequired) {
        setNeedCode(true);
        setError(code ? "Código de verificación inválido." : null);
      } else {
        setError(body.message ?? "No se pudo iniciar sesión");
      }
    } catch {
      setError("Error de conexión");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-950 p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-navy-700 bg-navy-900 p-8 text-navy-200 shadow-pop">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white">
            <ShieldCheck size={18} />
          </div>
          <div>
            <h1 className="font-semibold text-white">TuBot · Plataforma</h1>
            <p className="text-[11px] text-navy-300">Administración de la plataforma</p>
          </div>
        </div>
        <label className="block text-sm">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white" />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white" />
        </label>
        {needCode && (
          <label className="block text-sm">
            Código de verificación
            <input
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 dígitos de tu app"
              className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 tracking-widest text-white"
            />
            <span className="mt-1 block text-[11px] text-navy-400">O usa un código de recuperación.</span>
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {loading ? "Entrando…" : needCode ? "Verificar" : "Entrar"}
        </button>
        <p className="text-[11px] text-navy-300">Acceso exclusivo para administradores de la plataforma TuBot.</p>
      </form>
    </main>
  );
}
