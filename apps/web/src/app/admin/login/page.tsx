"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { padmin, setPlatformToken } from "@/lib/platform-api";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("superadmin@conversia.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await padmin<{ token: string }>("/platform/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setPlatformToken(res.token);
      router.push("/admin");
    } catch (err) {
      setError((err as Error).message);
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
            <h1 className="font-semibold text-white">Conversia · Plataforma</h1>
            <p className="text-[11px] text-navy-300">Administración de la plataforma</p>
          </div>
        </div>
        <label className="block text-sm">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white" />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {loading ? "Entrando…" : "Entrar"}
        </button>
        <p className="text-[11px] text-navy-300">Acceso exclusivo para administradores de la plataforma Conversia.</p>
      </form>
    </main>
  );
}
