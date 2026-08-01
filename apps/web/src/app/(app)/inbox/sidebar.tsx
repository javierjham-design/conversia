"use client";

/** Sidebar clasificador de la Bandeja (grupos colapsables con conteos en vivo). */
import { useState } from "react";
import { Ban, Bot, ChevronDown, ChevronRight, Inbox, Plus, Tags, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import type { ChannelInfo, Counters, InboxFilter } from "./types";

function Group({
  title,
  children,
  defaultOpen = true,
  action,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        {action}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

function Item({
  label,
  count,
  active,
  onClick,
  icon,
  color,
  onDelete,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  color?: string | null;
  onDelete?: () => void;
}) {
  return (
    <div className={cn("group flex items-center", active ? "bg-cyan-50" : "hover:bg-slate-50")}>
      <button onClick={onClick} className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-[13px]", active ? "font-medium text-cyan-800" : "text-slate-600")}>
        {color ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : icon}
        <span className="truncate">{label}</span>
        {typeof count === "number" && (
          <span className={cn("ml-auto shrink-0 rounded-full px-1.5 text-[10px]", active ? "bg-cyan-100 text-cyan-700" : "bg-slate-100 text-slate-500")}>{count}</span>
        )}
      </button>
      {onDelete && (
        <button onClick={onDelete} className="mr-2 hidden text-slate-300 hover:text-red-500 group-hover:block" title="Eliminar bandeja">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

export function InboxSidebar({
  counters,
  filter,
  onSelect,
  channels,
  onViewsChanged,
}: {
  counters: Counters | null;
  filter: InboxFilter;
  onSelect: (f: InboxFilter) => void;
  channels: ChannelInfo[];
  onViewsChanged: () => void;
}) {
  const toast = useToast();
  const [showNewView, setShowNewView] = useState(false);
  const is = (k: string, id?: string) =>
    filter.kind === k && (id === undefined || (filter as { id?: string; code?: string }).id === id || (filter as { code?: string }).code === id);

  return (
    <nav className="flex h-full w-52 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white py-2">
      <Group title="Bandeja">
        <Item label="Todas" icon={<Inbox size={13} />} count={counters?.fixed.all} active={is("all")} onClick={() => onSelect({ kind: "all" })} />
        <Item label="Mías" icon={<Users size={13} />} count={counters?.fixed.mine} active={is("mine")} onClick={() => onSelect({ kind: "mine" })} />
        <Item label="Sin asignar" icon={<Users size={13} />} count={counters?.fixed.unassigned} active={is("unassigned")} onClick={() => onSelect({ kind: "unassigned" })} />
        <Item label="No respondidas" icon={<Inbox size={13} />} count={counters?.fixed.unanswered} active={is("unanswered")} onClick={() => onSelect({ kind: "unanswered" })} />
      </Group>

      {(counters?.agents.length ?? 0) > 0 && (
        <Group title="Agentes IA">
          {counters!.agents.map((a) => (
            <Item key={a.id} label={a.name} icon={<Bot size={13} />} count={a.count} active={is("agent", a.id)} onClick={() => onSelect({ kind: "agent", id: a.id, label: a.name })} />
          ))}
        </Group>
      )}

      {(counters?.stages.length ?? 0) > 0 && (
        <Group title="Ciclo de vida">
          {counters!.stages.map((s) => (
            <Item key={s.code} label={s.name} color={s.color ?? "#94a3b8"} count={s.count} active={is("stage", s.code)} onClick={() => onSelect({ kind: "stage", code: s.code, label: s.name })} />
          ))}
        </Group>
      )}

      {(counters?.teams.length ?? 0) > 0 && (
        <Group title="Bandejas de equipo">
          {counters!.teams.map((t) => (
            <Item key={t.id} label={t.name} icon={<Users size={13} />} count={t.count} active={is("team", t.id)} onClick={() => onSelect({ kind: "team", id: t.id, label: t.name })} />
          ))}
        </Group>
      )}

      <Group
        title="Personalizadas"
        action={
          <button onClick={() => setShowNewView(true)} className="text-slate-400 hover:text-cyan-600" title="Nueva bandeja personalizada">
            <Plus size={13} />
          </button>
        }
      >
        {(counters?.views.length ?? 0) === 0 && (
          <p className="px-3 py-1 text-[11px] text-slate-400">Guarda filtros con el botón +</p>
        )}
        {counters?.views.map((v) => (
          <Item
            key={v.id}
            label={v.name}
            icon={<Tags size={13} />}
            count={v.count}
            active={is("view", v.id)}
            onClick={() => onSelect({ kind: "view", id: v.id, label: v.name })}
            onDelete={() => {
              void api(`/inbox/views/${v.id}`, { method: "DELETE" }).then(() => {
                toast.push("Bandeja eliminada", "info");
                onViewsChanged();
                if (filter.kind === "view" && filter.id === v.id) onSelect({ kind: "all" });
              });
            }}
          />
        ))}
      </Group>

      <div className="mt-auto border-t border-slate-100 pt-1">
        <Item label="Contactos bloqueados" icon={<Ban size={13} />} count={counters?.fixed.blocked} active={is("blocked")} onClick={() => onSelect({ kind: "blocked" })} />
      </div>

      {showNewView && (
        <NewViewModal
          channels={channels}
          stages={counters?.stages ?? []}
          onClose={() => setShowNewView(false)}
          onCreated={() => {
            setShowNewView(false);
            onViewsChanged();
          }}
        />
      )}
    </nav>
  );
}

function NewViewModal({
  channels,
  stages,
  onClose,
  onCreated,
}: {
  channels: ChannelInfo[];
  stages: { code: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [status, setStatus] = useState("open");
  const [channelId, setChannelId] = useState("");
  const [assigned, setAssigned] = useState("");
  const [ai, setAi] = useState("");
  const [stageCode, setStageCode] = useState("");
  const [tags, setTags] = useState("");
  const [hasAd, setHasAd] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/inbox/views", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          definition: {
            ...(status !== "all" ? { status } : {}),
            ...(channelId ? { channelId } : {}),
            ...(assigned ? { assigned } : {}),
            ...(ai ? { ai } : {}),
            ...(stageCode ? { stageCode } : {}),
            ...(tags.trim() ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
            ...(hasAd ? { hasAd: hasAd === "si" } : {}),
          },
        }),
      });
      toast.push("Bandeja guardada ✔", "ok");
      onCreated();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const sel = "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm";
  return (
    <Modal open onClose={onClose} title="Nueva bandeja personalizada">
      <div className="space-y-2.5">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Calientes de anuncios" className={sel} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Estado</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
              <option value="open">Abiertas</option>
              <option value="closed">Cerradas</option>
              <option value="all">Todas</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Canal</span>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={sel}>
              <option value="">Cualquiera</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Asignado</span>
            <select value={assigned} onChange={(e) => setAssigned(e.target.value)} className={sel}>
              <option value="">Cualquiera</option>
              <option value="me">Mías</option>
              <option value="unassigned">Sin asignar</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Control</span>
            <select value={ai} onChange={(e) => setAi(e.target.value)} className={sel}>
              <option value="">IA y humano</option>
              <option value="on">Con IA</option>
              <option value="off">Humano</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Etapa</span>
            <select value={stageCode} onChange={(e) => setStageCode(e.target.value)} className={sel}>
              <option value="">Cualquiera</option>
              {stages.map((s) => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Origen anuncio</span>
            <select value={hasAd} onChange={(e) => setHasAd(e.target.value)} className={sel}>
              <option value="">Da igual</option>
              <option value="si">Desde anuncio</option>
              <option value="no">Sin anuncio</option>
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Etiquetas (separadas por coma)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="interesado, ortodoncia" className={sel} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void save()} disabled={busy || name.trim().length < 2}>Guardar bandeja</Button>
        </div>
      </div>
    </Modal>
  );
}
