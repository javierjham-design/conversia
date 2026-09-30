"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileUp, GitMerge, Upload, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Checkbox, Modal, Select, cn, useToast } from "@/components/ui";
import { buildTemplateCsv, guessField, parseCSV, parseSpreadsheetFile, TEMPLATE_BASE_HEADERS } from "./contact-csv";

const inputCls = "w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none focus:border-brand-500";

// Campos destino del import (etiqueta legible + descripción del formato esperado).
const TARGET_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "", label: "— Ignorar —" },
  { key: "firstName", label: "Nombre" },
  { key: "lastName", label: "Apellido" },
  { key: "phone", label: "Teléfono", hint: "con código de país, ej: +56 9 1234 5678" },
  { key: "email", label: "Email" },
  { key: "country", label: "País (ISO-2)", hint: "ej: CL, AR, MX" },
  { key: "locale", label: "Idioma", hint: "ej: es" },
  { key: "tags", label: "Etiquetas", hint: "separadas por | o coma" },
  { key: "group", label: "Grupos", hint: "separados por | o coma (se crean solos)" },
  { key: "stage", label: "Etapa del ciclo de vida", hint: "code o nombre" },
];

type Group = { id: string; name: string; count: number };

export function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: { row: number; reason: string }[] } | null>(null);
  const [customFields, setCustomFields] = useState<{ key: string; label: string }[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupChoice, setGroupChoice] = useState(""); // "" = ninguno · id · "__new__"
  const [newGroupName, setNewGroupName] = useState("");
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (open) {
      void api<{ key: string; label: string }[]>("/contact-fields").then((r) => setCustomFields(r.map((f) => ({ key: f.key, label: f.label })))).catch(() => setCustomFields([]));
      void api<Group[]>("/contacts/groups").then(setGroups).catch(() => setGroups([]));
      setParsed(null);
      setMapping({});
      setUpdateExisting(false);
      setProgress(null);
      setResult(null);
      setGroupChoice("");
      setNewGroupName("");
    }
  }, [open]);

  async function onFile(file: File) {
    try {
      const p = await parseSpreadsheetFile(file);
      if (p.headers.length === 0) {
        toast.push("El archivo no tiene cabeceras (la primera fila debe ser los títulos de columna)", "error");
        return;
      }
      setParsed(p);
      setMapping(Object.fromEntries(p.headers.map((h, i) => {
        const guessed = guessField(h);
        if (guessed) return [i, guessed];
        const custom = customFields.find((f) => f.key === h.trim().toLowerCase());
        return [i, custom ? `custom:${custom.key}` : ""];
      })));
    } catch (e: any) {
      toast.push(e?.message ?? "No pudimos leer el archivo. Asegúrate de que sea CSV o Excel (.xlsx).", "error");
    }
  }

  function downloadTemplate() {
    const csv = buildTemplateCsv(customFields);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plantilla-contactos.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const mappedFields = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);
  const canImport = parsed && (mappedFields.has("phone") || mappedFields.has("email") || mappedFields.has("firstName"));

  // El import corre como job en 2.º plano: encolamos y hacemos polling del
  // estado hasta que el worker termina (o falla).
  async function doImport() {
    if (!parsed) return;
    setBusy(true);
    try {
      // Grupo destino de TODAS las filas (opcional): crea el grupo nuevo si aplica.
      let groupId: string | undefined;
      if (groupChoice === "__new__" && newGroupName.trim()) {
        const g = await api<{ id: string }>("/contacts/groups", { method: "POST", body: JSON.stringify({ name: newGroupName.trim() }) });
        groupId = g.id;
      } else if (groupChoice && groupChoice !== "__new__") {
        groupId = groupChoice;
      }
      const rows = parsed.rows.map((r) => {
        const obj: Record<string, unknown> = {};
        const custom: Record<string, string> = {};
        Object.entries(mapping).forEach(([idx, field]) => {
          const val = r[Number(idx)]?.trim();
          if (!field || !val) return;
          if (field.startsWith("custom:")) custom[field.slice(7)] = val;
          else obj[field] = val;
        });
        if (Object.keys(custom).length) obj.custom = custom;
        return obj;
      });
      const queued = await api<{ jobId: string; total: number }>("/contacts/import", { method: "POST", body: JSON.stringify({ rows, updateExisting, groupId }) });
      setProgress({ processed: 0, total: queued.total });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const st = await api<{ state: string; progress: { processed: number; total: number }; result: typeof result; error: string | null }>(`/contacts/import/${queued.jobId}`);
        if (st.state === "completed" && st.result) {
          setResult(st.result);
          onDone();
          break;
        }
        if (st.state === "failed") {
          toast.push(st.error ?? "El import falló", "error");
          break;
        }
        setProgress(st.progress ?? { processed: 0, total: queued.total });
      }
    } catch (e: any) {
      toast.push(e.message ?? "Error al importar", "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Importar base de datos de contactos" wide>
      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Creados" value={result.created} tone="ok" />
            <Stat label="Actualizados" value={result.updated} tone="brand" />
            <Stat label="Omitidos" value={result.skipped} tone="muted" />
          </div>
          {result.errors.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-500/30">
              <p className="mb-1 font-medium text-amber-700 dark:text-amber-300">{result.errors.length} fila(s) con problemas</p>
              {result.errors.slice(0, 30).map((e) => (
                <p key={e.row} className="text-amber-700 dark:text-amber-300">Fila {e.row}: {e.reason}</p>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : !parsed ? (
        <div className="space-y-4">
          {/* Formato esperado — siempre visible antes de subir */}
          <div className="rounded-xl border border-line bg-app p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink">Formato del archivo</p>
              <Button variant="secondary" onClick={downloadTemplate}><Download size={14} /> Descargar plantilla</Button>
            </div>
            <p className="text-xs text-ink-muted">
              Acepta <b>Excel (.xlsx)</b> o <b>CSV</b>. La <b>primera fila</b> son los títulos de columna. Reconocemos automáticamente estas columnas (puedes ajustar el mapeo después):
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TEMPLATE_BASE_HEADERS.map((h) => (
                <span key={h} className="rounded-md border border-line-strong bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-muted">{h}</span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle">Lo único imprescindible es <b>teléfono</b> (con código de país, ej: +56 9 1234 5678). El resto es opcional. Puedes clasificar en <b>grupos</b> con la columna «grupos» (separados por | o coma).</p>
          </div>

          <button
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f); }}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed py-10 text-ink-muted transition",
              dragOver ? "border-brand-500 bg-brand-50/40 text-brand-600 dark:bg-brand-500/10" : "border-line-strong bg-app hover:border-brand-400 hover:text-brand-600",
            )}
          >
            <FileUp size={28} />
            <span className="font-medium">Arrastra tu archivo aquí o haz clic para seleccionar</span>
            <span className="flex items-center gap-1 text-xs"><FileSpreadsheet size={13} /> Excel (.xlsx) o CSV</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{parsed.rows.length} filas detectadas. Asocia cada columna del archivo a un campo:</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {parsed.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{h || `Columna ${i + 1}`}</p>
                  <p className="truncate text-xs text-ink-subtle">{parsed.rows[0]?.[i] ?? ""}</p>
                </div>
                <Select value={mapping[i] ?? ""} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} className="w-56">
                  {TARGET_FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}{f.hint ? ` — ${f.hint}` : ""}</option>
                  ))}
                  {customFields.map((f) => (
                    <option key={`custom:${f.key}`} value={`custom:${f.key}`}>Campo: {f.label}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>

          {/* Clasificar todo el archivo en un grupo */}
          <div className="rounded-lg border border-line bg-app p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink"><Users size={14} /> Clasificar estos contactos en un grupo (opcional)</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)} className="w-64">
                <option value="">— Sin grupo —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name} ({g.count})</option>
                ))}
                <option value="__new__">➕ Crear grupo nuevo…</option>
              </Select>
              {groupChoice === "__new__" && (
                <input className={cn(inputCls, "w-56")} placeholder="Nombre del grupo nuevo" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} maxLength={80} />
              )}
            </div>
            <p className="mt-1 text-[11px] text-ink-subtle">Todos los contactos importados se agregarán a este grupo (además de los grupos que traiga la columna «grupos»).</p>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <Checkbox checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
            Actualizar contactos existentes (mismo teléfono) rellenando campos vacíos
          </label>
          {!canImport && <p className="text-xs text-amber-600 dark:text-amber-400">Mapea al menos Teléfono, Email o Nombre para poder importar.</p>}
          {progress && (
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-app">
                <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.round((progress.processed / Math.max(progress.total, 1)) * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-ink-muted">Procesando {progress.processed} de {progress.total}…</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setParsed(null)} disabled={busy}>Volver</Button>
            <Button onClick={doImport} disabled={busy || !canImport}><Upload size={15} /> {busy ? "Importando…" : `Importar ${parsed.rows.length}`}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "brand" | "muted" }) {
  const c = tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : tone === "brand" ? "text-brand-600 dark:text-brand-400" : "text-ink-muted";
  return (
    <div className="rounded-lg border border-line p-3 text-center">
      <p className={cn("text-2xl font-semibold", c)}>{value}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}

// ==================== Historial de mensajes (Respond.io) ====================

/** Import del export de MENSAJES de Respond.io: tandas de 5000, idempotente. */
export function ImportMessagesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  useEffect(() => {
    if (open) {
      setRows(null);
      setResult(null);
      setProgress(null);
    }
  }, [open]);

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const p = parseCSV(String(reader.result ?? ""));
      const idx = (name: string) => p.headers.findIndex((h) => h.trim().toLowerCase() === name);
      const map = {
        dateTime: idx("date & time"), senderType: idx("sender type"), contactId: idx("contact id"),
        messageId: idx("message id"), contentType: idx("content type"), messageType: idx("message type"),
        content: idx("content"), channelId: idx("channel id"),
      };
      if (map.messageId < 0 || map.contactId < 0 || map.dateTime < 0) {
        toast.push("No parece el export de mensajes de Respond.io (faltan columnas)", "error");
        return;
      }
      setRows(p.rows.map((r) => ({
        dateTime: r[map.dateTime] ?? "", senderType: r[map.senderType] ?? "", contactId: r[map.contactId] ?? "",
        messageId: r[map.messageId] ?? "", contentType: r[map.contentType] ?? "", messageType: r[map.messageType] ?? "",
        content: r[map.content] ?? "", channelId: r[map.channelId] ?? "",
      })).filter((r) => r.messageId && r.contactId));
    };
    reader.readAsText(file, "utf-8");
  }

  async function run() {
    if (!rows) return;
    setBusy(true);
    const totals = { imported: 0, skippedDuplicate: 0, skippedNoContact: 0, conversationsCreated: 0, errors: [] as any[] };
    try {
      for (let i = 0; i < rows.length; i += 5000) {
        const slice = rows.slice(i, i + 5000);
        setProgress(`Tanda ${Math.floor(i / 5000) + 1} de ${Math.ceil(rows.length / 5000)} — enviando ${slice.length} mensajes…`);
        const q = await api<{ jobId: string }>("/contacts/import-messages", { method: "POST", body: JSON.stringify({ rows: slice }) });
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const st = await api<any>(`/contacts/import-messages/${q.jobId}`);
          if (st.state === "completed" && st.result) {
            for (const k of ["imported", "skippedDuplicate", "skippedNoContact", "conversationsCreated"] as const) (totals as any)[k] += st.result[k] ?? 0;
            totals.errors.push(...(st.result.errors ?? []));
            break;
          }
          if (st.state === "failed") { totals.errors.push({ row: i + 1, reason: st.error ?? "job falló" }); break; }
          if (st.progress?.processed != null) setProgress(`Tanda ${Math.floor(i / 5000) + 1}: ${st.progress.processed}/${st.progress.total} procesados…`);
        }
      }
      setResult(totals);
    } catch (e: any) {
      toast.push(e.message ?? "Error al importar", "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Importar historial de mensajes (Respond.io)" wide>
      {result ? (
        <div className="space-y-3">
          <p className="text-sm">✅ Importados: <b>{result.imported}</b> · Duplicados omitidos: {result.skippedDuplicate} · Sin contacto: {result.skippedNoContact} · Conversaciones creadas: {result.conversationsCreated}</p>
          {result.errors.length > 0 && <p className="text-xs text-amber-700">{result.errors.length} error(es): {result.errors.slice(0, 5).map((e: any) => e.reason).join(" · ")}</p>}
          <div className="flex justify-end"><Button onClick={onClose}>Listo</Button></div>
        </div>
      ) : !rows ? (
        <div>
          <p className="mb-3 text-sm text-ink-muted">Sube el CSV de <b>Data export → Messages</b> de Respond.io. Es seguro correrlo más de una vez (los duplicados se omiten) y NO dispara agentes, flujos ni webhooks.</p>
          <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong bg-app py-10 text-ink-subtle hover:border-brand-400 hover:text-brand-600">
            <FileUp size={28} /><span className="font-medium">Selecciona el CSV de mensajes</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">{rows.length.toLocaleString("es-CL")} mensajes detectados. Se envían en tandas de 5.000.</p>
          {progress && <p className="text-xs text-brand-600">{progress}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRows(null)} disabled={busy}>Volver</Button>
            <Button onClick={() => void run()} disabled={busy}><Upload size={15} /> {busy ? "Importando…" : "Importar historial"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ============================= Duplicados / fusión =============================

interface DupItem { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; profileName: string | null; createdAt: string; lastContactAt: string | null }
interface DupGroup { phone: string; items: DupItem[] }

function dupName(c: DupItem): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}

export function DuplicatesModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [primary, setPrimary] = useState<Record<string, string>>({}); // phone -> primaryId
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    setGroups(null);
    api<{ groups: DupGroup[] }>("/contacts/duplicates")
      .then((r) => {
        setGroups(r.groups);
        setPrimary(Object.fromEntries(r.groups.map((g) => [g.phone, g.items[0].id])));
      })
      .catch((e) => toast.push(e.message ?? "Error", "error"));
  }
  useEffect(() => {
    if (open) load();
  }, [open]);

  async function mergeGroup(g: DupGroup) {
    const primaryId = primary[g.phone];
    const mergeIds = g.items.map((i) => i.id).filter((id) => id !== primaryId);
    if (mergeIds.length === 0) return;
    setBusy(g.phone);
    try {
      await api("/contacts/merge", { method: "POST", body: JSON.stringify({ primaryId, mergeIds }) });
      toast.push("Contactos fusionados", "ok");
      setGroups((prev) => (prev ? prev.filter((x) => x.phone !== g.phone) : prev));
      onDone();
    } catch (e: any) {
      toast.push(e.message ?? "Error al fusionar", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Contactos duplicados" wide>
      {!groups ? (
        <p className="py-8 text-center text-sm text-ink-subtle">Buscando duplicados…</p>
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">No se encontraron contactos con el mismo teléfono. 🎉</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{groups.length} grupo(s) comparten teléfono. Elige el contacto principal (conserva su ficha) y fusiona el resto.</p>
          {groups.map((g) => (
            <div key={g.phone} className="rounded-xl border border-line p-3">
              <p className="mb-2 font-mono text-xs text-ink-muted">{g.phone}</p>
              <div className="space-y-1.5">
                {g.items.map((c) => (
                  <label key={c.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm", primary[g.phone] === c.id ? "border-brand-300 bg-brand-50 dark:bg-brand-500/10 dark:border-brand-500/40" : "border-line")}>
                    <input type="radio" name={`p-${g.phone}`} checked={primary[g.phone] === c.id} onChange={() => setPrimary({ ...primary, [g.phone]: c.id })} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{dupName(c)}</p>
                      <p className="truncate text-xs text-ink-subtle">{c.email ?? "sin email"} · creado {new Date(c.createdAt).toLocaleDateString("es-CL")}</p>
                    </div>
                    {primary[g.phone] === c.id && <span className="shrink-0 text-[11px] font-medium text-brand-600 dark:text-brand-400">Principal</span>}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <Button onClick={() => mergeGroup(g)} disabled={busy === g.phone}>
                  <GitMerge size={15} /> {busy === g.phone ? "Fusionando…" : `Fusionar ${g.items.length - 1} en el principal`}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
