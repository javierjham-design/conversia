import { describe, it, expect } from "vitest";
import { MockStorage, crearStorage, claveDeMedio, extensionDeMime } from "./index.js";

describe("sin configuración NO hay storage, y eso es lo normal", () => {
  it("devuelve null con el entorno vacío", () => {
    expect(crearStorage({})).toBeNull();
  });

  it("con la configuración A MEDIAS tampoco: un storage que falla en cada escritura es peor que ninguno", () => {
    expect(crearStorage({ S3_BUCKET: "b" })).toBeNull();
    expect(crearStorage({ S3_BUCKET: "b", S3_ACCESS_KEY: "k" })).toBeNull();
    expect(crearStorage({ S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s" })).toBeNull();
  });

  it("con bucket y las dos llaves, sí", () => {
    const s = crearStorage({ S3_BUCKET: "medios", S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s" });
    expect(s?.bucket).toBe("medios");
  });

  it("los espacios en blanco no cuentan como configuración", () => {
    expect(crearStorage({ S3_BUCKET: "  ", S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s" })).toBeNull();
  });
});

describe("el doble en memoria se comporta como el real", () => {
  it("guarda, lee, mide y borra", async () => {
    const s = new MockStorage();
    expect(await s.get("x")).toBeNull();
    await s.put("x", Buffer.from("hola"), "text/plain");
    expect((await s.get("x"))?.body.toString()).toBe("hola");
    expect(await s.head("x")).toEqual({ size: 4, mime: "text/plain" });
    await s.del("x");
    expect(await s.get("x")).toBeNull();
    expect(await s.head("x")).toBeNull();
  });

  it("pedir algo que no existe devuelve null, no una excepción (es el caso del primer uso)", async () => {
    const s = new MockStorage();
    await expect(s.get("no-esta")).resolves.toBeNull();
    await expect(s.del("no-esta")).resolves.toBeUndefined();
  });
});

describe("la clave del objeto", () => {
  it("lleva la organización ADELANTE, para poder borrar o listar por tenant sin mirar la base", () => {
    expect(claveDeMedio("org1", "m1", "image", "image/jpeg")).toBe("org1/m1/image.jpg");
  });

  it("la extensión sale del mime", () => {
    expect(extensionDeMime("image/png")).toBe("png");
    expect(extensionDeMime("audio/mpeg")).toBe("mp3");
    expect(extensionDeMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionDeMime("application/pdf")).toBe("pdf");
    expect(extensionDeMime("video/mp4")).toBe("mp4");
  });

  it("un mime raro no genera una clave rara", () => {
    expect(extensionDeMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("bin");
    expect(extensionDeMime("")).toBe("bin");
    expect(claveDeMedio("org1", "m1", "document", "")).toBe("org1/m1/document.bin");
  });
});
