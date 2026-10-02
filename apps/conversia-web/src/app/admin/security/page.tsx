"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { padmin } from "@/lib/platform-api";

/**
 * MFA (2FA TOTP) del super admin. El backend exige MFA antes de dar acceso al resto de la
 * consola, así que esta pantalla es la puerta de entrada en el primer ingreso: generar el
 * secreto → escanear/ingresar en la app de autenticación → verificar con un código. Al
 * verificar, se muestran los códigos de recuperación UNA sola vez.
 */
export default function AdminSecurity() {
  const router = useRouter();
  const [status, setStatus] = useState<{ enabled: boolean; pending: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => padmin<{ enabled: boolean; pending: boolean }>("/platform/auth/mfa/status").then(setStatus).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function enroll() {
    setError(null);
    setBusy(true);
    try {
      const r = await padmin<{ secret: string; otpauthUri: string }>("/platform/auth/mfa/enroll", { method: "POST" });
      setSecret(r.secret);
      setOtpauth(r.otpauthUri);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await padmin<{ enabled: boolean; recoveryCodes: string[] }>("/platform/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setRecovery(r.recoveryCodes);
      setSecret(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    padding: "11px 13px",
    marginTop: 6,
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--surface-solid)",
    color: "var(--ink)",
    fontSize: 15,
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Seguridad</h1>
      <p className="text-dim" style={{ margin: "0 0 22px", fontSize: 14 }}>Verificación en dos pasos (2FA) de tu cuenta de super admin.</p>
      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

      {recovery ? (
        <div className="card" style={{ padding: 20 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>✅ 2FA activado.</p>
          <p className="text-dim" style={{ fontSize: 13 }}>Guarda estos códigos de recuperación en un lugar seguro. Se muestran una sola vez.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontFamily: "monospace", margin: "12px 0" }}>
            {recovery.map((c) => (
              <code key={c} style={{ background: "var(--acc-dim)", padding: "6px 10px", borderRadius: 8 }}>{c}</code>
            ))}
          </div>
          <button className="btn-accent" onClick={() => router.replace("/admin")}>Ir al panel</button>
        </div>
      ) : status?.enabled ? (
        <div className="card" style={{ padding: 20 }}>
          <p style={{ margin: 0 }}>🔒 La verificación en dos pasos está <b>activa</b>.</p>
          <button className="btn-accent" onClick={() => router.replace("/admin")} style={{ marginTop: 14 }}>Ir al panel</button>
        </div>
      ) : secret ? (
        <form onSubmit={verify} className="card" style={{ padding: 20 }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>1 · Agrega la cuenta a tu app de autenticación</p>
          <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Usa Google Authenticator, Authy, 1Password… Ingresa esta <b>clave manual</b>:</p>
          <code style={{ display: "block", background: "var(--acc-dim)", padding: "10px 12px", borderRadius: 10, margin: "10px 0", fontFamily: "monospace", wordBreak: "break-all", fontSize: 15 }}>{secret}</code>
          {otpauth ? <p className="text-dim" style={{ fontSize: 11, wordBreak: "break-all", margin: "0 0 12px" }}>URI: {otpauth}</p> : null}
          <p style={{ margin: "6px 0", fontWeight: 600 }}>2 · Ingresa el código de 6 dígitos</p>
          <input style={field} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="123456" autoFocus />
          <button className="btn-accent" type="submit" disabled={busy} style={{ marginTop: 16, width: "100%", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Verificando…" : "Activar 2FA"}
          </button>
        </form>
      ) : (
        <div className="card" style={{ padding: 20 }}>
          <p style={{ margin: "0 0 12px" }}>Aún no has activado la verificación en dos pasos. Es obligatoria para operar la consola.</p>
          <button className="btn-accent" onClick={enroll} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>
            {busy ? "Generando…" : "Activar 2FA"}
          </button>
        </div>
      )}
    </div>
  );
}
