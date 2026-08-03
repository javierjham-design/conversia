/**
 * Validación de imágenes subidas (logo/avatar) SIN dependencias nativas:
 * tipo real por magic bytes (no la extensión) + dimensiones desde el header.
 * Soporta PNG, JPEG y WebP (VP8/VP8L/VP8X).
 */

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export function sniffImage(buf: Buffer): ImageInfo | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR (width/height big-endian en bytes 16-23)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: FF D8 FF … buscar el marcador SOF (C0-C3, C5-C7, C9-CB, CD-CF)
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + chunk VP8 / VP8L / VP8X
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        mime: "image/webp",
        width: 1 + (buf.readUIntLE(24, 3) & 0xffffff),
        height: 1 + (buf.readUIntLE(27, 3) & 0xffffff),
      };
    }
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

export const IMAGE_LIMITS = {
  maxBytes: 2 * 1024 * 1024, // 2 MB
  maxDimension: 2048, // px (el navegador ya redimensiona a ≤512)
};

/** Valida una imagen subida. Devuelve la info o lanza con motivo en español. */
export function validateUploadedImage(buf: Buffer): ImageInfo {
  if (buf.length > IMAGE_LIMITS.maxBytes) {
    throw new Error(`La imagen supera ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB`);
  }
  const info = sniffImage(buf);
  if (!info) throw new Error("El archivo no es una imagen PNG, JPG o WebP válida (se valida el contenido, no la extensión)");
  if (info.width < 1 || info.height < 1 || info.width > IMAGE_LIMITS.maxDimension || info.height > IMAGE_LIMITS.maxDimension) {
    throw new Error(`Dimensiones fuera de rango (máx ${IMAGE_LIMITS.maxDimension}px por lado)`);
  }
  return info;
}
