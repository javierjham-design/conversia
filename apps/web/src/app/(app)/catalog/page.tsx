"use client";

/** Módulo de Catálogo: ver lo importado (tienda, menú o manual), buscar, DESACTIVAR lo
 * que el bot no debe ofrecer y editar la descripción-para-el-bot (sin tocar la tienda). */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Checkbox, PageHeader, Select, Skeleton, useToast } from "@/components/ui";
import { CsvImport } from "./csv-import";

interface Item {
  id: string; name: string; sku: string | null; source: string; kind: string; category: string | null;
  price: number | null; currency: string; available: boolean; active: boolean; stock: number | null;
  botDescription: string | null; description: string | null; imageUrl: string | null; productUrl: string | null;
}
interface Resp { total: number; page: number; categories: string[]; items: Item[] }

const money = (n: number | null, c: string) => (n == null ? "—" : c === "CLP" ? `$${n.toLocaleString("es-CL")}` : `US$${n.toFixed(2)}`);
const SOURCE_LABEL: Record<string, string> = { manual: "Manual", woocommerce: "WooCommerce", shopify: "Shopify", jumpseller: "Jumpseller", bsale: "Bsale", fudo: "Fudo", csv: "CSV" };

export default function CatalogPage() {
  const toast = useToast();
  const [data, setData] = useState<Resp | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (query) p.set("query", query);
    if (category) p.set("category", category);
    p.set("page", String(page));
    try { setData(await api<Resp>(`/integrations/catalog/items?${p.toString()}`)); } catch (e) { toast.push((e as Error).message, "error"); }
  }, [query, category, page, toast]);
  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    try { await api(`/integrations/catalog/items/${id}`, { method: "PATCH", body: JSON.stringify(body) }); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / 40)) : 1;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6">
      <PageHeader title="Catálogo" description="Lo que el bot puede vender: productos de tu tienda, tu menú o lo que cargaste a mano. Desactiva lo que no quieras que ofrezca y ajusta la descripción para WhatsApp." actions={<Button variant="secondary" onClick={() => setImporting(true)}>Importar CSV</Button>} />
      <CsvImport open={importing} onClose={() => setImporting(false)} onDone={() => void load()} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Buscar producto o SKU…" className="w-64 rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm" />
        <Select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
          <option value="">Todas las categorías</option>
          {data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        {data && <span className="text-xs text-ink-subtle">{data.total} productos</span>}
      </div>

      {!data ? (
        <Skeleton className="h-96" />
      ) : data.items.length === 0 ? (
        <div className="rounded-card border border-line bg-panel p-8 text-center text-sm text-ink-muted">
          Sin productos todavía. Conecta tu tienda en <a href="/integrations" className="text-brand-600 underline">Integraciones</a> o carga tu catálogo.
        </div>
      ) : (
        <div className="space-y-2">
          {data.items.map((it) => (
            <div key={it.id} className={`rounded-card border bg-panel p-3 shadow-card ${it.active ? "border-line" : "border-line opacity-60"}`}>
              <div className="flex items-start gap-3">
                {it.imageUrl ? <img src={it.imageUrl} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="h-12 w-12 rounded-lg bg-app" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{it.name}</p>
                    <span className="rounded bg-app px-1.5 py-0.5 text-[10px] text-ink-muted">{SOURCE_LABEL[it.source] ?? it.source}</span>
                    {!it.available && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">sin stock</span>}
                  </div>
                  <p className="text-xs text-ink-subtle">{[it.sku, it.category, money(it.price, it.currency), it.stock != null ? `stock ${it.stock}` : null].filter(Boolean).join(" · ")}</p>
                  {editing === it.id ? (
                    <div className="mt-2">
                      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Descripción para el bot (la que vende en WhatsApp)…" className="w-full rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm" />
                      <div className="mt-1 flex gap-2">
                        <Button onClick={() => { void patch(it.id, { botDescription: draft }); setEditing(null); }}>Guardar</Button>
                        <button onClick={() => setEditing(null)} className="text-xs text-ink-subtle hover:text-ink">Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-ink-muted">
                      {it.botDescription ? <span>{it.botDescription}</span> : <span className="text-ink-subtle italic">{it.description?.slice(0, 120) || "Sin descripción para el bot"}</span>}
                      <button onClick={() => { setEditing(it.id); setDraft(it.botDescription ?? ""); }} className="ml-2 text-brand-600 hover:underline">editar</button>
                    </p>
                  )}
                </div>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-muted">
                  <Checkbox checked={it.active} onChange={(e) => void patch(it.id, { active: e.target.checked })} />
                  El bot lo ofrece
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {data && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">‹</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-line px-2 py-1 disabled:opacity-40">›</button>
        </div>
      )}
    </div>
  );
}
