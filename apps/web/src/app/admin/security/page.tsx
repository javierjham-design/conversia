"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
}

export default function SecurityPage() {
  const toast = useToast();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDisable, setShowDisable] = useState(false);
  const [disablePw, setDisablePw] = useState("");

  const load = useCallback(async () => {
    setStatus(await padmin<MfaStatus>("/platform/auth/mfa/status"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function startEnroll() {
    setBusy(true);
    try {
      setEnroll(await padmin("/platform/auth/mfa/enroll", { method: "POST" }));
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    setBusy(true);
    try {
      const res = await padmin<{ recoveryCodes: string[] }>("/platform/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setRecovery(res.recoveryCodes);
      setEnroll(null);
      setCode("");
      toast.push("MFA activado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa() {
    setBusy(true);
    try {
      await padmin("/platform/auth/reauth", { method: "POST", body: JSON.stringify({ password: disablePw }) });
      await padmin("/platform/auth/mfa/disable", { method: "POST" });
      setShowDisable(false);
      setDisablePw("");
      toast.push("MFA desactivado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6 lg:px-8">
      <PageHeader title="Seguridad" description="Protege el acceso a la administración de la plataforma." />

      <div className="rounded-card border border-slate-200 bg-white p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-navy-900">Autenticación en dos pasos (MFA)</h2>
            <p className="text-sm text-slate-500">Un código temporal de tu teléfono, además de la contraseña.</p>
          </div>
          {status && <StatusBadge kind={status.enabled ? "connected" : "disconnected"} label={status.enabled ? "activo" : "inactivo"} />}
        </div>

        {!status ? (
          <Skeleton className="h-24" />
        ) : status.enabled ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Tu cuenta está protegida con MFA. Se te pedirá un código al iniciar sesión.</p>
            {!showDisable ? (
              <Button variant="danger" onClick={() => setShowDisable(true)}>Desactivar MFA</Button>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-sm text-slate-600">Confirma tu contraseña para desactivar (acción crítica).</p>
                <input
                  type="password"
                  value={disablePw}
                  onChange={(e) => setDisablePw(e.target.value)}
                  placeholder="Contraseña"
                  className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button variant="danger" disabled={busy || !disablePw} onClick={() => void disableMfa()}>Confirmar</Button>
                  <Button variant="secondary" onClick={() => setShowDisable(false)}>Cancelar</Button>
                </div>
              </div>
            )}
          </div>
        ) : enroll ? (
          <div className="space-y-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
              <li>Abre Google Authenticator, Authy o 1Password.</li>
              <li>Elige “agregar cuenta” → “ingresar clave manualmente” y pega esta clave:</li>
            </ol>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="break-all font-mono text-sm tracking-wider text-navy-900">{enroll.secret}</p>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(enroll.secret);
                  toast.push("Clave copiada", "ok");
                }}
                className="mt-1 text-xs text-brand-600 hover:underline"
              >
                Copiar clave
              </button>
            </div>
            <label className="block text-sm">
              Ingresa el código de 6 dígitos que muestra la app
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 tracking-widest"
              />
            </label>
            <div className="flex gap-2">
              <Button disabled={busy || code.length < 6} onClick={() => void confirmEnroll()}>Activar</Button>
              <Button variant="secondary" onClick={() => setEnroll(null)}>Cancelar</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Aún no tienes MFA. Recomendado para una cuenta con acceso total a la plataforma.</p>
            <Button disabled={busy} onClick={() => void startEnroll()}>Activar MFA</Button>
          </div>
        )}
      </div>

      {recovery && (
        <div className="mt-4 rounded-card border border-amber-300 bg-amber-50 p-6 shadow-card">
          <h3 className="font-semibold text-amber-900">Guarda tus códigos de recuperación</h3>
          <p className="mt-1 text-sm text-amber-800">
            Se muestran <b>una sola vez</b>. Cada uno sirve para entrar si pierdes el teléfono. Guárdalos en un lugar seguro.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm">
            {recovery.map((c) => (
              <span key={c} className="rounded bg-white px-2 py-1 text-center text-navy-900">{c}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(recovery.join("\n"));
                toast.push("Códigos copiados", "ok");
              }}
            >
              Copiar todos
            </Button>
            <Button onClick={() => setRecovery(null)}>Ya los guardé</Button>
          </div>
        </div>
      )}
    </div>
  );
}
