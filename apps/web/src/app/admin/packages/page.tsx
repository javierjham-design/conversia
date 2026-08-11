"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, useToast } from "@/components/ui";

interface Pkg {
  id: string;
  code: string;
  name: string;
  credits: number;
  priceClp: number;
  priceUsd: number;
  active: boolean;
  order: number;
}

const blank = { code: "", name: "", credits: 1000, priceClp: 29900, priceUsd: 34, active: true, order: 0 };

export default function PackagesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Pkg[] | null>(null);
  const [draft, setDraft] = useState<typeof blank | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setRows(await padmin<Pkg[]>("/platform/packages"));
  }
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(id: string | null, data: Partial<Pkg>) {
    setBusy(true);
    try {
      await padmin(id ? `/platform/packages/${id}` : "/platform/packages", { method: id ? "PATCH" : "POST", body: JSON.stringify(data) });
      toast.push("Guardado ✔", "ok");
      setDraft(null);
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar este paquete?")) return;
    try {
      await padmin(`/platform/packages/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 lg:px-8">
      <PageHeader title="Paquetes de mensajes" description="Paquetes adicionales prepago que el tenant compra cuando se le agota la bolsa." />

      {!rows ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-card border border-slate-200 bg-white p-3 shadow-card">
              <input defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && void save(p.id, { name: e.target.value })} className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
              <span className="text-xs text-slate-400">{p.code}</span>
              <label className="text-xs text-slate-500">créditos <input type="number" defaultValue={p.credits} onBlur={(e) => Number(e.target.value) !== p.credits && void save(p.id, { credits: Number(e.target.value) })} className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
              <label className="text-xs text-slate-500">CLP <input type="number" defaultValue={p.priceClp} onBlur={(e) => Number(e.target.value) !== p.priceClp && void save(p.id, { priceClp: Number(e.target.value) })} className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
              <label className="text-xs text-slate-500">USD <input type="number" step="0.01" defaultValue={p.priceUsd} onBlur={(e) => Number(e.target.value) !== p.priceUsd && void save(p.id, { priceUsd: Number(e.target.value) })} className="w-20 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
              <label className="flex items-center gap-1 text-xs text-slate-500">activo <input type="checkbox" defaultChecked={p.active} onChange={(e) => void save(p.id, { active: e.target.checked })} /></label>
              <button onClick={() => void remove(p.id)} className="ml-auto text-slate-400 hover:text-red-500" aria-label="Eliminar"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}

      {draft ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 rounded-card border border-brand-200 bg-brand-50/40 p-3">
          <label className="text-xs text-slate-600">código<input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="msgs_2000" className="mt-0.5 block w-32 rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          <label className="text-xs text-slate-600">nombre<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="2.000 mensajes" className="mt-0.5 block w-40 rounded border border-slate-300 px-2 py-1 text-sm" /></label>
          <label className="text-xs text-slate-600">créditos<input type="number" value={draft.credits} onChange={(e) => setDraft({ ...draft, credits: Number(e.target.value) })} className="mt-0.5 block w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
          <label className="text-xs text-slate-600">CLP<input type="number" value={draft.priceClp} onChange={(e) => setDraft({ ...draft, priceClp: Number(e.target.value) })} className="mt-0.5 block w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
          <label className="text-xs text-slate-600">USD<input type="number" step="0.01" value={draft.priceUsd} onChange={(e) => setDraft({ ...draft, priceUsd: Number(e.target.value) })} className="mt-0.5 block w-20 rounded border border-slate-300 px-2 py-1 text-right text-sm" /></label>
          <Button disabled={busy || !draft.code || !draft.name} onClick={() => void save(null, draft)}>Crear</Button>
          <Button variant="secondary" onClick={() => setDraft(null)}>Cancelar</Button>
        </div>
      ) : (
        <button onClick={() => setDraft({ ...blank })} className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
          <Plus size={15} /> Nuevo paquete
        </button>
      )}
    </div>
  );
}
