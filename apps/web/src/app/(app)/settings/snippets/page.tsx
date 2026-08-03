"use client";

/** Respuestas rápidas del compositor (atajo "/"), con ámbito equipo/personal. */
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Skeleton, useToast } from "@/components/ui";

interface SnippetRow {
  id: string;
  shortcut: string;
  body: string;
  scope: string;
}

export default function SnippetsSettingsPage() {
  const toast = useToast();
  const [items, setItems] = useState<SnippetRow[] | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("team");

  const load = useCallback(async () => {
    setItems(await api<SnippetRow[]>("/inbox/snippets").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    try {
      await api("/inbox/snippets", {
        method: "POST",
        body: JSON.stringify({ shortcut: shortcut.trim().toLowerCase(), body: body.trim(), scope }),
      });
      setShortcut("");
      setBody("");
      toast.push("Respuesta rápida creada", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  if (!items) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Respuestas rápidas</h2>
      <p className="mt-1 text-xs text-slate-500">
        Se usan con <code className="rounded bg-slate-100 px-1">/atajo</code> en el compositor de la Bandeja. Admiten
        variables como <code className="rounded bg-slate-100 px-1">{"{{contact.firstName}}"}</code>. Ámbito «Equipo» = las
        ve todo el equipo; «Solo yo» = solo quien la creó.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="atajo (ej: saludo)" className="w-36 rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs" />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Hola {{contact.firstName}}! ¿En qué te ayudo?" className="min-w-52 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs">
          <option value="team">Equipo</option>
          <option value="mine">Solo yo</option>
        </select>
        <Button onClick={() => void add()} disabled={shortcut.trim().length < 2 || body.trim().length < 2}><Plus size={14} /> Crear</Button>
      </div>

      <ul className="mt-3 space-y-1">
        {items.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">Sin respuestas rápidas aún.</p>}
        {items.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-2 py-1.5 text-xs">
            <span className="w-28 shrink-0 font-mono text-cyan-700">/{s.shortcut}</span>
            <span className="min-w-0 flex-1 truncate text-slate-600">{s.body}</span>
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{s.scope === "mine" ? "Solo yo" : "Equipo"}</span>
            <button
              onClick={() => void api(`/inbox/snippets/${s.id}`, { method: "DELETE" }).then(load)}
              className="text-slate-300 hover:text-red-500"
              title="Eliminar"
            >✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
