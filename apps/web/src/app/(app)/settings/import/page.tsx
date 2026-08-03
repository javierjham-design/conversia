"use client";

/** Importar contactos (CSV): misma lógica del módulo Contactos, con historial. */
import { useCallback, useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Skeleton } from "@/components/ui";
import { ImportModal } from "../../contacts/contact-import-merge";

interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export default function ImportSettingsPage() {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AuditRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: AuditRow[] }>("/settings/audit?module=contact.import");
      setHistory(res.items);
    } catch {
      setHistory([]); // roles sin acceso al audit igual pueden importar
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Importar contactos</h2>
      <p className="mt-1 text-xs text-slate-500">
        Sube un CSV (hasta 10.000 filas): se procesa en segundo plano con dedupe por teléfono. La misma herramienta está
        disponible en el módulo Contactos.
      </p>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-5 text-center shadow-card">
        <Button onClick={() => setOpen(true)}><Upload size={14} /> Importar CSV</Button>
      </div>

      <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Historial de imports</h3>
      {!history ? (
        <Skeleton className="mt-2 h-32" />
      ) : history.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">Sin imports registrados.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {history.map((h) => (
            <li key={h.id} className="rounded-lg border border-slate-100 bg-white px-3 py-1.5 text-xs">
              <span className="text-slate-600">{new Date(h.createdAt).toLocaleString("es-CL")}</span>
              <span className="ml-2 text-slate-400">por {h.actorName ?? "—"}</span>
              {h.after && <span className="ml-2 text-slate-500">{JSON.stringify(h.after).slice(0, 120)}</span>}
            </li>
          ))}
        </ul>
      )}

      <ImportModal open={open} onClose={() => setOpen(false)} onDone={() => void load()} />
    </div>
  );
}
