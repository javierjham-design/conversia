"use client";
import { LADO_MAXIMO, medidaReducida, soloBase64, tipoDeArchivo, type AdjuntoListo } from "./adjuntos";

/**
 * La parte que toca el navegador: leer el archivo y, si es una foto, ACHICARLA antes de
 * subirla. Las decisiones (qué se acepta, qué se le dice al dueño, a cuánto se reduce)
 * viven en `adjuntos.ts`, que sí se puede probar; acá solo está el canvas y el FileReader.
 */

function leerComoDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(fr.error ?? new Error("No se pudo leer el archivo"));
    fr.readAsDataURL(blob);
  });
}

/**
 * Reduce una imagen a `LADO_MAXIMO` y la vuelve JPEG. Un pantallazo de un teléfono pesa
 * varios MB y el modelo lo escala igual antes de mirarlo: subirlo entero es pagar por
 * píxeles que nadie va a ver. Si algo falla (un formato que el navegador no decodifica),
 * devuelve el original: mejor subir de más que no poder mandar la foto.
 */
async function achicarImagen(archivo: File): Promise<{ mime: string; dataUrl: string }> {
  const original = await leerComoDataUrl(archivo);
  // Los GIF pueden ser animados y el canvas los aplana a un cuadro: van tal cual.
  if (/gif/i.test(archivo.type)) return { mime: archivo.type, dataUrl: original };
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("imagen ilegible"));
      el.src = original;
    });
    const { ancho, alto } = medidaReducida(img.naturalWidth, img.naturalHeight, LADO_MAXIMO);
    if (ancho === img.naturalWidth && alto === img.naturalHeight && archivo.size < 900_000) {
      return { mime: archivo.type, dataUrl: original };
    }
    const lienzo = document.createElement("canvas");
    lienzo.width = ancho;
    lienzo.height = alto;
    const cx = lienzo.getContext("2d");
    if (!cx) return { mime: archivo.type, dataUrl: original };
    cx.drawImage(img, 0, 0, ancho, alto);
    return { mime: "image/jpeg", dataUrl: lienzo.toDataURL("image/jpeg", 0.82) };
  } catch {
    return { mime: archivo.type, dataUrl: original };
  }
}

/** Deja un archivo listo para mandárselo a Convi. `null` si no sabemos qué es. */
export async function prepararAdjunto(archivo: File): Promise<AdjuntoListo | null> {
  const tipo = tipoDeArchivo(archivo.type, archivo.name);
  if (!tipo) return null;
  if (tipo === "imagen") {
    const { mime, dataUrl } = await achicarImagen(archivo);
    const base64 = soloBase64(dataUrl);
    return { tipo, nombre: archivo.name || "foto.jpg", mime, dataBase64: base64, bytes: Math.round((base64.length * 3) / 4) };
  }
  const base64 = soloBase64(await leerComoDataUrl(archivo));
  return {
    tipo,
    nombre: archivo.name || (tipo === "audio" ? "nota.ogg" : "archivo"),
    mime: archivo.type || "text/plain",
    dataBase64: base64,
    bytes: archivo.size,
  };
}

/** ¿Se puede grabar audio en este navegador? (Safari viejo y http sin TLS no pueden.) */
export function puedeGrabar(): boolean {
  try {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  } catch {
    return false;
  }
}
