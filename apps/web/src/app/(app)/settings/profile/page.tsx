"use client";

/** Mi perfil (configuración PERSONAL — cualquier rol): nombre, contraseña. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { roleLabel } from "@/lib/labels";
import { Button, Skeleton, cn, useToast } from "@/components/ui";
import { useMe } from "../../layout";
import { ImageUpload } from "../image-upload";
import { MfaCard } from "./mfa-card";

export default function ProfilePage() {
  const toast = useToast();
  const me = useMe();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me?.user?.name) setName(me.user.name);
  }, [me?.user?.name]);

  const reqs = [
    { ok: next.length >= 8, label: "Mínimo 8 caracteres" },
    { ok: /[a-zA-Z]/.test(next), label: "Al menos una letra" },
    { ok: /[0-9]/.test(next), label: "Al menos un número" },
    { ok: next.length > 0 && next === next2, label: "Las contraseñas coinciden" },
  ];
  const passOk = reqs.every((r) => r.ok) && current.length > 0;

  async function saveName() {
    setBusy(true);
    try {
      await api("/auth/me", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      toast.push("Nombre actualizado ✔ (se refleja al recargar)", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword() {
    setBusy(true);
    try {
      await api("/auth/change-password", { method: "POST", body: JSON.stringify({ current, next }) });
      setCurrent("");
      setNext("");
      setNext2("");
      toast.push("Contraseña cambiada ✔", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <div className="mx-auto max-w-xl p-6"><Skeleton className="h-64" /></div>;
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm";

  return (
    <div className="mx-auto max-w-xl p-6">
      <h2 className="text-lg font-semibold">Mi perfil</h2>
      <p className="mt-1 text-xs text-ink-muted">Configuración personal — solo te afecta a ti, no a la organización.</p>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <div className="flex items-center gap-4">
          <ImageUpload
            uploadPath="/settings/profile/avatar"
            servePath={`/settings/avatar/${me.user?.id ?? ""}`}
            deletePath="/settings/profile/avatar"
            label="Foto"
            round
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">{me.user?.name}</p>
            <p className="text-xs text-ink-subtle">{me.user?.email} · {roleLabel(me.role)}</p>
          </div>
        </div>
        <label className="mt-3 block text-sm">
          <span className="text-xs text-ink-muted">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <div className="mt-2 flex justify-end">
          <Button onClick={() => void saveName()} disabled={busy || name.trim().length < 2 || name.trim() === me.user?.name}>Guardar cambios</Button>
        </div>
      </div>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Cambiar contraseña</p>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          <label className="block text-sm">
          <span className="text-xs text-ink-muted">Contraseña actual</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Nueva contraseña</span>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Repite la nueva</span>
            <input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} className={input} />
          </label>
        </div>
        <ul className="mt-2 flex flex-wrap gap-3 text-[11px]">
          {reqs.map((r) => (
            <li key={r.label} className={cn("flex items-center gap-1", r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-ink-subtle")}>
              {r.ok ? "✓" : "○"} {r.label}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => void changePassword()} disabled={busy || !passOk}>Cambiar contraseña</Button>
        </div>
        <p className="mt-2 text-[10px] text-ink-subtle">
          Nota: no existe aún «cerrar sesión en todos los dispositivos» — las sesiones expiran solas a las 12 h
          (brecha anotada; llegará con los refresh tokens).
        </p>
      </div>

      <MfaCard />
    </div>
  );
}
