"use client";
/**
 * Subida del LOGO del negocio para el mini-sitio. El endpoint (`/settings/logo`) y el
 * almacenamiento existían desde siempre —TuBot ya tenía el control—, pero el panel de Conversia
 * nunca tuvo dónde subirlo: la página pública salía sin la marca del cliente.
 *
 * Redimensiona en el navegador a ≤512 px antes de mandar; el servidor igual re-valida por magic
 * bytes y dimensiones, porque esto es un cliente y un cliente se puede saltar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { apiBase } from "@/lib/api-base";

const MAX_BYTES = 2 * 1024 * 1024;

async function redimensionar(file: File, max = 512): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * escala));
  const h = Math.max(1, Math.round(bitmap.height * escala));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

export function SubirLogo({ onCambio }: { onCambio?: (hayLogo: boolean) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [hayLogo, setHayLogo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // El logo se sirve autenticado, así que no se puede poner la URL en un <img src>: hay que
  // pedirlo con el token y convertirlo en un blob local.
  const cargar = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase()}/settings/logo`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
      // Solo lo tratamos como imagen si de verdad lo es: un 200 que no sea una imagen dejaría
      // un <img> roto en pantalla en vez del marcador de "sin logo".
      if (res.ok && res.headers.get("content-type")?.startsWith("image/")) {
        setPreview(URL.createObjectURL(await res.blob()));
        setHayLogo(true);
        onCambio?.(true);
        return;
      }
    } catch {
      /* sin logo subido */
    }
    setPreview(null);
    setHayLogo(false);
    onCambio?.(false);
  }, [onCambio]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function subir(file: File) {
    setError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError("Tiene que ser PNG, JPG o WebP.");
    if (file.size > MAX_BYTES) return setError("La imagen supera los 2 MB.");
    setOcupado(true);
    try {
      const dataBase64 = (await redimensionar(file)).split(",")[1] ?? "";
      await api("/settings/logo", { method: "POST", body: JSON.stringify({ dataBase64, filename: file.name }) });
      await cargar();
    } catch (e) {
      setError((e as Error).message || "No se pudo subir el logo.");
    } finally {
      setOcupado(false);
    }
  }

  async function quitar() {
    setError(null);
    setOcupado(true);
    try {
      await api("/settings/logo", { method: "DELETE" });
      await cargar();
    } catch (e) {
      setError((e as Error).message || "No se pudo quitar el logo.");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-label="Subir logo del negocio"
          style={{
            width: 76, height: 76, flexShrink: 0, borderRadius: 14, cursor: "pointer",
            border: "2px dashed var(--line)", background: "var(--bg)", color: "var(--ink-dim)",
            display: "grid", placeItems: "center", overflow: "hidden", padding: 0,
          }}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Logo del negocio" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <ImageIcon size={24} />
          )}
        </button>
        <div style={{ minWidth: 0 }}>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={ocupado}
            className="card"
            style={{ cursor: "pointer", fontSize: 13, padding: "7px 13px", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            {ocupado ? <Loader2 size={13} className="lp-spin" /> : <Upload size={13} />}
            {ocupado ? "Subiendo…" : hayLogo ? "Cambiar logo" : "Subir logo"}
          </button>
          {hayLogo ? (
            <button
              type="button"
              onClick={() => void quitar()}
              disabled={ocupado}
              style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--ink-dim)", textDecoration: "underline" }}
            >
              <Trash2 size={11} /> Quitar
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--warn)" }}>{error}</p> : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Se limpia el input para que volver a elegir EL MISMO archivo dispare el change.
          e.target.value = "";
          if (f) void subir(f);
        }}
      />
    </div>
  );
}
