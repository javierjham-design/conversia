"use client";

/** Importar contactos (CSV): misma lógica del módulo Contactos, con historial. */
import { useCallback, useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Skeleton } from "@/components/ui";
import { ImportModal } from "../../contacts/contact-import-merge";
import { buildTemplateCsv } from "../../contacts/contact-csv";

interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

const BASE_COLUMNS: { col: string; desc: string; ejemplo: string }[] = [
  { col: "telefono", desc: "OBLIGATORIO para dedupe — con código de país", ejemplo: "+56 9 1234 5678" },
  { col: "nombre", desc: "Nombre del contacto", ejemplo: "María" },
  { col: "apellido", desc: "Apellido(s)", ejemplo: "Pérez Soto" },
  { col: "email", desc: "Correo electrónico", ejemplo: "maria@ejemplo.cl" },
  { col: "etapa", desc: "Etapa del ciclo de vida (nombre o código; debe existir en Configuración → Etapas)", ejemplo: "Nuevo lead" },
  { col: "etiquetas", desc: "Separadas por | (también acepta coma)", ejemplo: "interesado|ortodoncia" },
];

export default function ImportSettingsPage() {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<{ key: string; label: string }[]>([]);
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
    void api<{ key: string; label: string }[]>("/contact-fields").then((r) => setFields(r.map((f) => ({ key: f.key, label: f.label })))).catch(() => setFields([]));
  }, [load]);

  function downloadTemplate() {
    const csv = buildTemplateCsv(fields);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "plantilla-contactos-tubot.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Importar contactos</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Sube un CSV (hasta 10.000 filas): se procesa en segundo plano con dedupe por teléfono. La misma herramienta está
        disponible en el módulo Contactos.
      </p>

      <div className="mt-4 flex items-center justify-center gap-3 rounded-card border border-line bg-panel p-5 shadow-card">
        <Button variant="secondary" onClick={downloadTemplate}>⬇ Descargar plantilla CSV</Button>
        <Button onClick={() => setOpen(true)}><Upload size={14} /> Importar CSV</Button>
      </div>

      <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Columnas aceptadas</h3>
      <div className="mt-2 overflow-x-auto rounded-card border border-line bg-panel shadow-card">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-line text-[10px] uppercase text-ink-subtle">
              <th className="p-2.5">Columna</th><th className="p-2.5">Descripción</th><th className="p-2.5">Ejemplo</th>
            </tr>
          </thead>
          <tbody>
            {BASE_COLUMNS.map((c) => (
              <tr key={c.col} className="border-b border-line">
                <td className="p-2.5 font-mono text-cyan-800">{c.col}</td>
                <td className="p-2.5 text-ink-muted">{c.desc}</td>
                <td className="p-2.5 font-mono text-ink-subtle">{c.ejemplo}</td>
              </tr>
            ))}
            {fields.map((f) => (
              <tr key={f.key} className="border-b border-line">
                <td className="p-2.5 font-mono text-cyan-800">{f.key}</td>
                <td className="p-2.5 text-ink-muted">Campo personalizado «{f.label}» (Configuración → Campos de contacto)</td>
                <td className="p-2.5 font-mono text-ink-subtle">—</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-3 py-2 text-[11px] text-ink-muted">
          <b>Duplicados</b>: se deduplica por teléfono — si el contacto ya existe se omite (o solo rellena campos vacíos si marcas «Actualizar existentes»). Acepta separador coma o punto y coma (Excel Chile) y UTF-8 con BOM (tildes OK).
        </p>
      </div>

      <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Historial de imports</h3>
      {!history ? (
        <Skeleton className="mt-2 h-32" />
      ) : history.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Sin imports registrados.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {history.map((h) => (
            <li key={h.id} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs">
              <span className="text-ink-muted">{new Date(h.createdAt).toLocaleString("es-CL")}</span>
              <span className="ml-2 text-ink-subtle">por {h.actorName ?? "—"}</span>
              {h.after && <span className="ml-2 text-ink-muted">{JSON.stringify(h.after).slice(0, 120)}</span>}
            </li>
          ))}
        </ul>
      )}

      <ImportModal open={open} onClose={() => setOpen(false)} onDone={() => void load()} />
    </div>
  );
}
