import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, sniffImage, validateUploadedImage } from "./images";

/** Construye headers mínimos válidos de cada formato para los tests. */
function pngBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpegBuf(w: number, h: number): Buffer {
  // FF D8 FF E0 (APP0 len 16) ... FF C0 (SOF0) len 17, prec, H, W
  const app0 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)]);
  const sof = Buffer.alloc(10);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([app0, sof, Buffer.alloc(4)]);
}
function webpVp8xBuf(w: number, h: number): Buffer {
  const b = Buffer.alloc(34);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe("validación de imágenes por magic bytes", () => {
  it("detecta PNG/JPEG/WebP con sus dimensiones reales", () => {
    expect(sniffImage(pngBuf(512, 512))).toEqual({ mime: "image/png", width: 512, height: 512 });
    expect(sniffImage(jpegBuf(300, 200))).toEqual({ mime: "image/jpeg", width: 300, height: 200 });
    expect(sniffImage(webpVp8xBuf(128, 64))).toEqual({ mime: "image/webp", width: 128, height: 64 });
  });

  it("rechaza archivos que NO son imagen aunque digan serlo (extensión mentirosa)", () => {
    expect(sniffImage(Buffer.from("GIF89a un gif no soportado"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='...'></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.4 no soy un logo"))).toBeNull();
    expect(() => validateUploadedImage(Buffer.from("MZ ejecutable disfrazado de .png"))).toThrow(/no es una imagen/);
  });

  it("rechaza gigantes: por peso (>2MB) y por dimensiones (>2048px)", () => {
    const huge = Buffer.alloc(IMAGE_LIMITS.maxBytes + 1);
    pngBuf(100, 100).copy(huge, 0);
    expect(() => validateUploadedImage(huge)).toThrow(/supera/);
    expect(() => validateUploadedImage(pngBuf(4000, 100))).toThrow(/Dimensiones/);
  });

  it("acepta una imagen válida dentro de los límites", () => {
    const info = validateUploadedImage(pngBuf(512, 512));
    expect(info.mime).toBe("image/png");
  });
});
