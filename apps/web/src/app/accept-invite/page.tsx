"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

interface InviteInfo {
  email: string;
  name: string;
  needsPassword: boolean;
}

function AcceptInviteInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError("Falta el token de la invitación.");
      return;
    }
    void api<InviteInfo>(`/auth/invite/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setLoadError((e as Error).message));
  }, [token]);

  async function submit() {
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/auth/accept-invite", { method: "POST", body: JSON.stringify({ token, password }) });
      setDone(true);
      setTimeout(() => router.replace("/login"), 1800);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-7 shadow-lg">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <img src="/brand/tubot-icon.png" alt="TuBot" className="h-11 w-11 object-contain" />
          <h1 className="text-lg font-semibold text-navy-900">Únete a tu equipo en TuBot</h1>
        </div>

        {loadError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-700">{loadError}</p>
        ) : !info ? (
          <p className="text-center text-sm text-slate-500">Cargando invitación…</p>
        ) : done ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-700">
            ¡Listo! Tu cuenta quedó activa. Redirigiendo al inicio de sesión…
          </p>
        ) : !info.needsPassword ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-slate-600">
              Ya tienes una cuenta con <b>{info.email}</b>. Inicia sesión con tu contraseña habitual.
            </p>
            <button
              onClick={() => router.replace("/login")}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Ir a iniciar sesión
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-center text-sm text-slate-600">
              Hola <b>{info.name}</b>, define una contraseña para tu cuenta <b>{info.email}</b>.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Contraseña (mín. 10 caracteres)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repite la contraseña"
              onKeyDown={(e) => e.key === "Enter" && password.length >= 10 && void submit()}
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={() => void submit()}
              disabled={busy || password.length < 10}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Activando…" : "Activar mi cuenta"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}
