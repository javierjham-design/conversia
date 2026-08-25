"use client";

/** Verificación en dos pasos (TOTP) — activar/desactivar + política de la organización. */
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "@/lib/api";
import { Button, Checkbox, cn, useToast } from "@/components/ui";

interface Status {
  enabled: boolean;
  role: string;
  requireMfaForAdmins: boolean;
}

export function MfaCard() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  // Enrolamiento.
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  // Desactivar.
  const [disabling, setDisabling] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  const load = () => api<Status>("/auth/mfa/status").then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, []);

  async function beginSetup() {
    setBusy(true);
    try {
      setSetup(await api("/auth/mfa/setup", { method: "POST", body: "{}" }));
      setRecovery(null);
      setCode("");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    setBusy(true);
    try {
      const r = await api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      setRecovery(r.recoveryCodes);
      setSetup(null);
      await load();
      toast.push("Verificación en dos pasos activada ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await api("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ code: disableCode.trim() }) });
      setDisabling(false);
      setDisableCode("");
      await load();
      toast.push("Verificación en dos pasos desactivada", "info");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleOrgRequire(enabled: boolean) {
    setBusy(true);
    try {
      await api("/auth/mfa/org-require", { method: "POST", body: JSON.stringify({ enabled }) });
      await load();
      toast.push(enabled ? "Ahora se exige MFA a propietario y administradores" : "Ya no se exige MFA a admins", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm";

  return (
    <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Verificación en dos pasos (2FA)</p>
          <p className="text-xs text-ink-subtle">Protege tu cuenta con un código de tu teléfono además de la contraseña.</p>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", status.enabled ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-app text-ink-subtle")}>
          {status.enabled ? "Activa" : "Inactiva"}
        </span>
      </div>

      {/* Códigos de recuperación recién generados */}
      {recovery && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Guarda tus códigos de recuperación (se muestran una sola vez):</p>
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm text-amber-900 dark:text-amber-100">
            {recovery.map((c) => (<span key={c}>{c}</span>))}
          </div>
        </div>
      )}

      {/* Flujo de activación */}
      {!status.enabled && !setup && (
        <div className="mt-3">
          <Button onClick={() => void beginSetup()} disabled={busy}>Activar 2FA</Button>
        </div>
      )}
      {setup && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-muted">Escanea con Google Authenticator o Authy y escribe el código de 6 dígitos:</p>
          <div className="flex justify-center rounded-lg bg-white p-3"><QRCodeSVG value={setup.otpauthUri} size={150} /></div>
          <p className="text-center text-[11px] text-ink-subtle">Clave manual: <span className="font-mono">{setup.secret}</span></p>
          <div className="flex items-end gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" className={`${input} text-center tracking-[0.2em]`} />
            <Button onClick={() => void confirmEnable()} disabled={busy || code.trim().length < 6}>Confirmar</Button>
          </div>
        </div>
      )}

      {/* Desactivar */}
      {status.enabled && !disabling && (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setDisabling(true)} disabled={busy}>Desactivar 2FA</Button>
        </div>
      )}
      {disabling && (
        <div className="mt-3 flex items-end gap-2">
          <label className="block flex-1 text-sm">
            <span className="text-xs text-ink-muted">Confirma con un código (app o recuperación)</span>
            <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} placeholder="123456" className={input} />
          </label>
          <Button variant="danger" onClick={() => void disable()} disabled={busy || disableCode.trim().length < 6}>Desactivar</Button>
        </div>
      )}

      {/* Política de la organización (solo propietario) */}
      {status.role === "owner" && (
        <label className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-sm">
          <Checkbox className="mt-0.5" checked={status.requireMfaForAdmins} onChange={(e) => void toggleOrgRequire(e.target.checked)} disabled={busy} />
          <span>
            Exigir 2FA a propietario y administradores
            <span className="block text-[11px] text-ink-subtle">Al iniciar sesión, quien no la tenga activa deberá configurarla antes de entrar.</span>
          </span>
        </label>
      )}
    </div>
  );
}
