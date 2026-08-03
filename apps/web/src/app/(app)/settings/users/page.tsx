"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  phone: string | null;
  lastLoginAt: string | null;
  active: boolean;
  roleCode: string;
  roleName: string;
  teams: string[];
}
interface Role {
  code: string;
  name: string;
  permissions: string[];
  system: boolean;
}
interface CatalogModule {
  module: string;
  label: string;
  description: string;
  actions: { key: string; label: string }[];
}
interface RoleDraft {
  code: string;
  name: string;
  permissions: string[];
  isNew: boolean;
}

const RESERVED = ["owner", "admin"];

/** "hoy 14:30", "ayer 09:12" o "28-07-2026, 18:45"; "—" si nunca entró. */
function fmtLastLogin(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return `hoy ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `ayer ${time}`;
  return `${d.toLocaleDateString("es-CL")} ${time}`;
}

function expandPerms(perms: string[], catalog: CatalogModule[]): string[] {
  const out = new Set<string>();
  for (const p of perms) {
    if (p === "*") catalog.forEach((m) => m.actions.forEach((a) => out.add(a.key)));
    else if (p.endsWith(":*")) catalog.find((m) => m.module === p.slice(0, -2))?.actions.forEach((a) => out.add(a.key));
    else out.add(p);
  }
  return Array.from(out);
}



export default function UsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [invite, setInvite] = useState({ email: "", name: "", roleCode: "operator" });
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  // Panel de edición de un usuario (click en la fila)
  const [selected, setSelected] = useState<Member | null>(null);
  const [profile, setProfile] = useState({ name: "", email: "", phone: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  function openMember(m: Member) {
    setSelected(m);
    setProfile({ name: m.name, email: m.email, phone: m.phone ?? "" });
    setResetResult(null);
  }

  async function saveProfile() {
    if (!selected) return;
    setSavingProfile(true);
    setMsg(null);
    try {
      await api(`/users/${selected.membershipId}/profile`, {
        method: "PATCH",
        body: JSON.stringify({
          name: profile.name.trim(),
          email: profile.email.trim().toLowerCase(),
          phone: profile.phone.trim() || null,
        }),
      });
      await load();
      setSelected(null);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function resetPassword() {
    if (!selected) return;
    if (!window.confirm(`¿Restablecer la contraseña de ${selected.name}? La actual dejará de funcionar.`)) return;
    setMsg(null);
    try {
      const r = await api<{ tempPassword: string }>(`/users/${selected.membershipId}/reset-password`, { method: "POST" });
      setResetResult(r.tempPassword);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  const load = useCallback(async () => {
    const [m, r, c] = await Promise.all([
      api<Member[]>("/users"),
      api<Role[]>("/users/roles"),
      api<CatalogModule[]>("/users/permissions"),
    ]);
    setMembers(m);
    setRoles(r);
    setCatalog(c);
  }, []);

  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setTempPassword(null);
    try {
      const r = await api<{ tempPassword: string | null }>("/users", { method: "POST", body: JSON.stringify(invite) });
      setTempPassword(r.tempPassword);
      setInvite({ email: "", name: "", roleCode: "operator" });
      await load();
      setMsg(r.tempPassword ? null : "Usuario existente agregado a la organización ✔");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function changeRole(membershipId: string, roleCode: string) {
    await api(`/users/${membershipId}`, { method: "PATCH", body: JSON.stringify({ roleCode }) });
    await load();
  }
  async function toggleActive(m: Member) {
    try {
      await api(`/users/${m.membershipId}`, { method: "PATCH", body: JSON.stringify({ active: !m.active }) });
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  // ---- Roles ----
  function newRole() {
    setDraft({ code: "", name: "", permissions: [], isNew: true });
  }
  function editRole(r: Role) {
    setDraft({ code: r.code, name: r.name, permissions: expandPerms(r.permissions, catalog), isNew: false });
  }
  function togglePerm(key: string) {
    setDraft((d) => (d ? { ...d, permissions: d.permissions.includes(key) ? d.permissions.filter((p) => p !== key) : [...d.permissions, key] } : d));
  }
  async function saveRole() {
    if (!draft) return;
    setMsg(null);
    try {
      if (draft.isNew) {
        await api("/users/roles", { method: "POST", body: JSON.stringify({ code: draft.code, name: draft.name, permissions: draft.permissions }) });
      } else {
        await api(`/users/roles/${draft.code}`, { method: "PATCH", body: JSON.stringify({ name: draft.name, permissions: draft.permissions }) });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  async function deleteRole(code: string) {
    if (!window.confirm("¿Eliminar este rol? Los usuarios deben estar reasignados.")) return;
    try {
      await api(`/users/roles/${code}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-xl font-semibold">Usuarios y roles</h1>
      <p className="mb-6 text-sm text-ink-muted">
        Quién entra al panel y con qué permisos. Los equipos de atención viven en{" "}
        <a href="/settings/teams" className="text-cyan-700 underline">Equipos</a>.
      </p>

      {msg && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</p>}
      {tempPassword && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p>Usuario creado. Contraseña temporal (se muestra solo una vez): <b className="font-mono">{tempPassword}</b></p>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(
                `Hola! Te invité al panel de nuestro equipo en TuBot.
Entra en https://www.tubot.cl/login
Usuario: ${invite.email}
Clave temporal: ${tempPassword}
(cámbiala al entrar en Configuración → Mi perfil)`,
              );
              setMsg("Mensaje de invitación copiado — pégalo en WhatsApp o correo ✔");
            }}
            className="mt-1 rounded-lg border border-amber-300 px-2 py-1 text-xs font-medium hover:bg-amber-100"
          >
            📋 Copiar mensaje de invitación (para WhatsApp)
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <form onSubmit={submitInvite} className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-panel p-4">
            <label className="text-sm">
              Email
              <input type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} className="mt-1 block w-56 rounded-lg border border-line-strong px-3 py-2" />
            </label>
            <label className="text-sm">
              Nombre
              <input required minLength={2} value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} className="mt-1 block w-44 rounded-lg border border-line-strong px-3 py-2" />
            </label>
            <label className="text-sm">
              Rol
              <select value={invite.roleCode} onChange={(e) => setInvite({ ...invite, roleCode: e.target.value })} className="mt-1 block rounded-lg border border-line-strong bg-panel px-3 py-2">
                {roles.map((r) => (
                  <option key={r.code} value={r.code}>{r.name}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">Invitar</button>
          </form>

          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-sm">
              <thead className="bg-app text-left text-xs text-ink-muted">
                <tr>
                  <th className="p-3">Usuario</th>
                  <th className="p-3">Rol</th>
                  <th className="p-3">Equipos</th>
                  <th className="p-3">Última conexión</th>
                  <th className="p-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr
                    key={m.membershipId}
                    onClick={() => openMember(m)}
                    className="cursor-pointer border-t border-line hover:bg-app"
                    title="Editar usuario"
                  >
                    <td className="p-3">
                      <div className="font-medium">{m.name}</div>
                      <div className="text-xs text-ink-subtle">{m.email}</div>
                    </td>
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <select value={m.roleCode} onChange={(e) => void changeRole(m.membershipId, e.target.value)} className="rounded-lg border border-line-strong bg-panel px-2 py-1 text-xs">
                        {roles.map((r) => (
                          <option key={r.code} value={r.code}>{r.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3 text-xs text-ink-muted">{m.teams.join(", ") || "—"}</td>
                    <td className="p-3 text-xs text-ink-muted" title={m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString("es-CL") : "Nunca ha iniciado sesión"}>
                      {fmtLastLogin(m.lastLoginAt)}
                    </td>
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => void toggleActive(m)} className={`rounded-lg px-2 py-1 text-xs ${m.active ? "bg-emerald-50 text-emerald-700" : "bg-app text-ink-muted"}`}>
                        {m.active ? "activo" : "inactivo"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside>
          <div className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-1 font-medium">Equipos</h2>
            <p className="text-xs text-ink-muted">Crea equipos (Ventas, Recepción, Sede…) y asigna miembros para las asignaciones de la Bandeja, agentes y flujos.</p>
            <a href="/settings/teams" className="mt-2 inline-block rounded-lg bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-800">Gestionar equipos ↗</a>
          </div>
        </aside>
      </div>

      {/* ------------------------------ Roles ------------------------------ */}
      <section className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="font-medium">Roles y permisos</h2>
            <p className="text-sm text-ink-muted">Define qué puede hacer cada tipo de usuario, desde solo responder mensajes hasta configurar todo.</p>
          </div>
          <button onClick={newRole} className="rounded-lg bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-800">+ Nuevo rol</button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => {
            const full = r.permissions.includes("*");
            const count = full ? "Acceso total" : `${expandPerms(r.permissions, catalog).length} permisos`;
            const locked = RESERVED.includes(r.code);
            return (
              <div key={r.code} className="rounded-xl border border-line bg-panel p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-ink-subtle">{r.code}{r.system ? " · sistema" : ""}</p>
                  </div>
                  {!locked && (
                    <div className="flex gap-2 text-xs">
                      <button onClick={() => editRole(r)} className="text-cyan-700 hover:underline">Editar</button>
                      {!r.system && <button onClick={() => void deleteRole(r.code)} className="text-ink-subtle hover:text-red-500">✕</button>}
                    </div>
                  )}
                </div>
                <p className="mt-2 text-xs text-ink-muted">{count}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Editor de usuario (click en la fila) */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
          <div className="absolute inset-0 bg-navy-950/50" onClick={() => setSelected(null)} />
          <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-panel p-6 shadow-xl">
            <h2 className="mb-1 text-lg font-semibold">{selected.name}</h2>
            <p className="mb-4 text-xs text-ink-subtle">
              {selected.roleName} · {selected.teams.join(", ") || "sin equipos"} · última conexión:{" "}
              {fmtLastLogin(selected.lastLoginAt)}
            </p>

            <div className="space-y-3">
              <label className="block text-sm">
                Nombre
                <input
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
                />
              </label>
              <label className="block text-sm">
                Email
                <input
                  type="email"
                  value={profile.email}
                  onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
                />
                <span className="mt-1 block text-[10px] text-ink-subtle">Es el email con el que inicia sesión.</span>
              </label>
              <label className="block text-sm">
                Teléfono (opcional)
                <input
                  value={profile.phone}
                  onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
                  placeholder="+56 9 …"
                  className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2"
                />
              </label>
            </div>

            <div className="mt-4 rounded-lg border border-line bg-app p-3">
              <p className="text-sm font-medium">Contraseña</p>
              {resetResult ? (
                <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Contraseña temporal (se muestra solo una vez): <b className="font-mono">{resetResult}</b>
                  <button
                    onClick={() => void navigator.clipboard.writeText(resetResult)}
                    className="ml-2 rounded border border-amber-300 px-1.5 py-0.5 text-[10px] hover:bg-amber-100"
                  >
                    Copiar
                  </button>
                  <span className="mt-1 block">Compártela por un canal seguro; al entrar conviene cambiarla.</span>
                </p>
              ) : (
                <>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Genera una contraseña temporal nueva. La actual deja de funcionar de inmediato.
                  </p>
                  <button
                    onClick={() => void resetPassword()}
                    className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                  >
                    Restablecer contraseña
                  </button>
                </>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setSelected(null)} className="rounded-lg border border-line-strong px-4 py-2 text-sm">
                Cerrar
              </button>
              <button
                onClick={() => void saveProfile()}
                disabled={savingProfile || !profile.name.trim() || !profile.email.trim()}
                className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50"
              >
                {savingProfile ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Editor de rol */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
          <div className="absolute inset-0 bg-navy-950/50" onClick={() => setDraft(null)} />
          <div className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-panel p-6 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold">{draft.isNew ? "Nuevo rol" : `Editar rol · ${draft.name}`}</h2>
            <div className="mb-3 flex gap-2">
              <label className="flex-1 text-sm">
                Nombre
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2" placeholder="p. ej. Operador de bandeja" />
              </label>
              {draft.isNew && (
                <label className="w-40 text-sm">
                  Código
                  <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" placeholder="operador2" />
                </label>
              )}
            </div>
            <div className="space-y-3">
              {catalog.map((mod) => (
                <fieldset key={mod.module} className="rounded-lg border border-line p-3">
                  <legend className="px-1 text-sm font-medium">{mod.label}</legend>
                  <p className="mb-1 text-xs text-ink-subtle">{mod.description}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {mod.actions.map((a) => (
                      <label key={a.key} className="flex items-center gap-2 text-sm text-ink">
                        <input type="checkbox" checked={draft.permissions.includes(a.key)} onChange={() => togglePerm(a.key)} className="h-4 w-4" />
                        {a.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setDraft(null)} className="rounded-lg border border-line-strong px-4 py-2 text-sm">Cancelar</button>
              <button onClick={() => void saveRole()} disabled={!draft.name || (draft.isNew && !draft.code)} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50">
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
