"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);

  // Botón de Google (opcional): solo aparece si GOOGLE_CLIENT_ID está configurado.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ clientId: string }>("/auth/google-config");
        if (!cfg.clientId || cancelled) return;
        await new Promise<void>((resolve, reject) => {
          if ((window as any).google?.accounts?.id) return resolve();
          const s = document.createElement("script");
          s.src = "https://accounts.google.com/gsi/client";
          s.async = true;
          s.defer = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("gsi"));
          document.head.appendChild(s);
        });
        if (cancelled) return;
        const g = (window as any).google;
        g.accounts.id.initialize({
          client_id: cfg.clientId,
          callback: async (resp: any) => {
            setError(null);
            try {
              const r = await api<{ token: string }>("/auth/google", {
                method: "POST",
                body: JSON.stringify({ credential: resp.credential }),
              });
              setToken(r.token);
              router.push("/inbox");
            } catch (err) {
              setError((err as Error).message);
            }
          },
        });
        const el = document.getElementById("google-btn");
        if (el) {
          g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 320, text: "continue_with" });
          setGoogleReady(true);
        }
      } catch {
        /* Google no configurado o no cargó: se muestra solo email/contraseña */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      router.push("/inbox");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-8 shadow-sm">
        <div className="text-center">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="mx-auto h-9 w-auto" />
          <p className="mt-2 text-sm text-ink-muted">Panel de atención conversacional</p>
        </div>
        <div id="google-btn" className="flex justify-center" />
        {googleReady && (
          <div className="flex items-center gap-3 text-xs text-ink-subtle">
            <span className="h-px flex-1 bg-line" />o<span className="h-px flex-1 bg-line" />
          </div>
        )}
        <label className="block text-sm">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
            required
          />
        </label>
        <label className="block text-sm">
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
