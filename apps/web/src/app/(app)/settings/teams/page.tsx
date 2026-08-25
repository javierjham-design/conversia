"use client";

/** Equipos de atención: CRUD + miembros. Consumidos por Bandeja, agentes y flujos. */
import { useCallback, useEffect, useState } from "react";
import { Inbox, Plus, Search, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, Skeleton, useToast } from "@/components/ui";

interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  openConversations: number;
  members: { userId: string; name: string }[];
}
interface Assignable {
  userId: string;
  name: string;
}

export default function TeamsSettingsPage() {
  const toast = useToast();
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [users, setUsers] = useState<Assignable[]>([]);
  const [newName, setNewName] = useState("");
  const [memberSearch, setMemberSearch] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<TeamRow | null>(null);

  const load = useCallback(async () => {
    setTeams(await api<TeamRow[]>("/users/teams").catch(() => []));
    setUsers(await api<Assignable[]>("/users/assignable").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (newName.trim().length < 2) return;
    try {
      await api("/users/teams", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
      setNewName("");
      toast.push("Equipo creado", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  if (!teams) return <div className="mx-auto max-w-3xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="text-lg font-semibold">Equipos</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Ventas, Recepción, Sede… Los equipos se usan en las asignaciones de la <b>Bandeja</b>, la acción «Asignar a» de
        los <b>agentes IA</b> y el paso «Asignar» de los <b>flujos</b>. Los usuarios y sus roles viven en{" "}
        <a href="/settings/users" className="text-brand-700 underline dark:text-brand-300">Usuarios</a>.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="Nuevo equipo (p. ej. Recepción)…"
          className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm"
        />
        <Button onClick={() => void create()} disabled={newName.trim().length < 2}><Plus size={14} /> Crear equipo</Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {teams.length === 0 && (
          <p className="col-span-full rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-subtle">
            Aún no hay equipos — crea el primero arriba.
          </p>
        )}
        {teams.map((t) => {
          const q = (memberSearch[t.id] ?? "").toLowerCase();
          const candidates = users.filter((u) => !t.members.some((m) => m.userId === u.userId) && (!q || u.name.toLowerCase().includes(q)));
          return (
            <div key={t.id} className="rounded-card border border-line bg-panel p-4 shadow-card">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <input
                    defaultValue={t.name}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name.length >= 2 && name !== t.name) {
                        void api(`/users/teams/${t.id}`, { method: "PATCH", body: JSON.stringify({ name }) }).then(load);
                      }
                    }}
                    className="w-full rounded border border-transparent px-1 py-0.5 text-sm font-semibold hover:border-line focus:border-brand-400"
                  />
                  <a href={`/inbox?team=${t.id}`} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-brand-700 underline dark:text-brand-300">
                    <Inbox size={11} /> {t.openConversations} conversación(es) asignadas hoy
                  </a>
                </div>
                <button onClick={() => setDeleting(t)} className="text-ink-subtle hover:text-red-500" title="Eliminar equipo">
                  <Trash2 size={14} />
                </button>
              </div>

              <p className="mt-2 flex items-center gap-1 text-[10px] font-semibold uppercase text-ink-subtle">
                <Users size={11} /> Miembros ({t.members.length})
              </p>
              <ul className="mt-1 space-y-0.5">
                {t.members.map((m) => (
                  <li key={m.userId} className="flex items-center justify-between rounded px-1 py-0.5 text-xs text-ink-muted hover:bg-app">
                    {m.name}
                    <button
                      onClick={() => void api(`/users/teams/${t.id}/members/${m.userId}`, { method: "DELETE" }).then(load)}
                      className="text-ink-subtle hover:text-red-500"
                      title="Quitar del equipo"
                    >
                      ✕
                    </button>
                  </li>
                ))}
                {t.members.length === 0 && <li className="text-xs text-ink-subtle">Sin miembros aún.</li>}
              </ul>

              <div className="relative mt-2">
                <Search size={11} className="pointer-events-none absolute left-2 top-2 text-ink-subtle" />
                <input
                  value={memberSearch[t.id] ?? ""}
                  onChange={(e) => setMemberSearch({ ...memberSearch, [t.id]: e.target.value })}
                  placeholder="Buscar para agregar…"
                  className="w-full rounded-lg border border-line py-1 pl-6 pr-2 text-xs"
                />
              </div>
              {(memberSearch[t.id] ?? "") !== "" && (
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                  {candidates.map((u) => (
                    <li key={u.userId}>
                      <button
                        onClick={() => {
                          void api(`/users/teams/${t.id}/members`, { method: "POST", body: JSON.stringify({ userId: u.userId }) }).then(() => {
                            setMemberSearch({ ...memberSearch, [t.id]: "" });
                            void load();
                          });
                        }}
                        className="w-full rounded px-1.5 py-0.5 text-left text-xs text-brand-700 hover:bg-brand-50 dark:text-brand-300"
                      >
                        + {u.name}
                      </button>
                    </li>
                  ))}
                  {candidates.length === 0 && <li className="px-1.5 text-xs text-ink-subtle">Sin coincidencias.</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api(`/users/teams/${deleting.id}`, { method: "DELETE" })
            .then((r: any) => {
              toast.push(`Equipo eliminado${r.unassigned ? ` — ${r.unassigned} conversación(es) quedaron sin equipo` : ""}`, "info");
              setDeleting(null);
              void load();
            })
            .catch((err) => toast.push((err as Error).message, "error"));
        }}
        title={`¿Eliminar el equipo «${deleting?.name}»?`}
        description={`Sus ${deleting?.openConversations ?? 0} conversación(es) asignadas quedarán sin equipo (no se cierran ni se pierden).`}
        confirmLabel="Eliminar equipo"
        danger
      />
    </div>
  );
}
