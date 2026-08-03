"use client";

/**
 * Subida de imagen compartida (logo del negocio / avatar): arrastrar o
 * seleccionar, redimensiona en el navegador a ≤512px, preview y quitar.
 * El servidor re-valida por magic bytes + dimensiones.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Trash2, Upload } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { cn, useToast } from "@/components/ui";

async function resizeToDataUrl(file: File, max = 512): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

export function ImageUpload({
  uploadPath,
  servePath,
  deletePath,
  label,
  round = false,
  fallbackUrl,
}: {
  uploadPath: string; // POST {dataBase64, filename}
  servePath: string; // GET imagen (autenticada)
  deletePath: string; // DELETE
  label: string;
  round?: boolean;
  /** compat: URL antigua (settings.general.logoUrl) mientras no suban archivo */
  fallbackUrl?: string;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<string | null>(null);
  const [hasUpload, setHasUpload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadCurrent = useCallback(async () => {
    try {
      const res = await fetch(`/backend${servePath}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
      if (res.ok) {
        setPreview(URL.createObjectURL(await res.blob()));
        setHasUpload(true);
        return;
      }
    } catch {
      /* sin imagen subida */
    }
    setHasUpload(false);
    setPreview(fallbackUrl || null);
  }, [servePath, fallbackUrl]);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  async function handleFile(file: File) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      toast.push("Formatos permitidos: PNG, JPG o WebP", "error");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.push("Máximo 2 MB", "error");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await resizeToDataUrl(file);
      const dataBase64 = dataUrl.split(",")[1] ?? "";
      await api(uploadPath, { method: "POST", body: JSON.stringify({ dataBase64, filename: file.name }) });
      toast.push(`${label} actualizado ✔`, "ok");
      await loadCurrent();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await api(deletePath, { method: "DELETE" });
    setPreview(fallbackUrl || null);
    setHasUpload(false);
    toast.push(`${label} quitado`, "info");
  }

  return (
    <div className="flex items-center gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden border-2 border-dashed bg-slate-50 text-slate-300 transition-colors",
          round ? "rounded-full" : "rounded-xl",
          dragging ? "border-cyan-400 bg-cyan-50" : "border-slate-200 hover:border-cyan-300",
        )}
        title={`Arrastra o haz clic para subir ${label.toLowerCase()}`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={label} className="h-full w-full object-contain" />
        ) : (
          <ImageIcon size={22} />
        )}
      </div>
      <div className="text-xs text-slate-500">
        <button onClick={() => inputRef.current?.click()} disabled={busy} className="flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <Upload size={12} /> {busy ? "Subiendo…" : `Subir ${label.toLowerCase()}`}
        </button>
        <p className="mt-1 text-[10px] text-slate-400">PNG, JPG o WebP · máx 2 MB · se ajusta a 512px</p>
        {hasUpload && (
          <button onClick={() => void remove()} className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400 underline hover:text-red-500">
            <Trash2 size={10} /> Quitar
          </button>
        )}
        {!hasUpload && fallbackUrl && <p className="mt-0.5 text-[10px] text-amber-600">Usando el logo por URL antiguo — sube un archivo para reemplazarlo.</p>}
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])} />
    </div>
  );
}
