/**
 * ALMACENAMIENTO DE ARCHIVOS — contrato único + un doble en memoria.
 *
 * Por qué existe (D4): los medios de WhatsApp **viven en Meta 30 días y después
 * desaparecen**. Hasta ahora cada vista los bajaba de Meta en el momento, así que una
 * conversación de hace dos meses queda con el chat lleno de archivos rotos: el dueño abre la
 * foto que le mandó un paciente y no hay nada. También significa que cada apertura es una
 * llamada a Graph, con su latencia y su cuota.
 *
 * Regla 3 de CLAUDE.md: todo adaptador tiene su Mock. `MockStorage` guarda en memoria y sirve
 * para desarrollo y para los tests; `S3Storage` habla con cualquier S3 (Cloudflare R2, el
 * bucket de Railway, MinIO). **Si no hay configuración, `crearStorage` devuelve null y todo
 * sigue funcionando exactamente como antes** — bajando de Meta cada vez.
 */

export interface ObjetoGuardado {
  key: string;
  mime: string;
  size: number;
}

export interface Storage {
  /** Nombre para logs y para `File.bucket`. */
  readonly bucket: string;
  put(key: string, body: Buffer, mime: string): Promise<ObjetoGuardado>;
  get(key: string): Promise<{ body: Buffer; mime: string } | null>;
  /** ¿Existe? Más barato que `get` cuando solo hace falta saberlo. */
  head(key: string): Promise<{ size: number; mime: string } | null>;
  del(key: string): Promise<void>;
}

/** Doble en memoria. Determinista y sin red: desarrollo y tests. */
export class MockStorage implements Storage {
  readonly bucket = "mock";
  private datos = new Map<string, { body: Buffer; mime: string }>();
  /** Para que los tests puedan afirmar sobre lo que pasó. */
  readonly puts: string[] = [];
  readonly gets: string[] = [];

  async put(key: string, body: Buffer, mime: string): Promise<ObjetoGuardado> {
    this.datos.set(key, { body, mime });
    this.puts.push(key);
    return { key, mime, size: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; mime: string } | null> {
    this.gets.push(key);
    return this.datos.get(key) ?? null;
  }

  async head(key: string): Promise<{ size: number; mime: string } | null> {
    const v = this.datos.get(key);
    return v ? { size: v.body.byteLength, mime: v.mime } : null;
  }

  async del(key: string): Promise<void> {
    this.datos.delete(key);
  }

  get tamaño(): number {
    return this.datos.size;
  }
}

export interface ConfigDeS3 {
  endpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

/**
 * S3 de verdad. El SDK se carga con `import()` PEREZOSO a propósito: pesa varios MB y la
 * mayoría de los procesos (el que corre migraciones, un script, un test) nunca guarda un
 * archivo. Cargarlo al importar el módulo le sumaría ese arranque a todos.
 */
export class S3Storage implements Storage {
  readonly bucket: string;
  private cliente: unknown | null = null;

  constructor(private cfg: ConfigDeS3) {
    this.bucket = cfg.bucket;
  }

  private async s3(): Promise<any> {
    if (this.cliente) return this.cliente;
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.cliente = new S3Client({
      region: this.cfg.region || "auto",
      ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey },
    });
    return this.cliente;
  }

  async put(key: string, body: Buffer, mime: string): Promise<ObjetoGuardado> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.s3();
    await c.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }));
    return { key, mime, size: body.byteLength };
  }

  async get(key: string): Promise<{ body: Buffer; mime: string } | null> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.s3();
    try {
      const r = await c.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const trozo of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(trozo));
      return { body: Buffer.concat(chunks), mime: String(r.ContentType ?? "application/octet-stream") };
    } catch {
      // Un objeto que no está NO es un error: es el caso normal del "primer uso".
      return null;
    }
  }

  async head(key: string): Promise<{ size: number; mime: string } | null> {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.s3();
    try {
      const r = await c.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), mime: String(r.ContentType ?? "application/octet-stream") };
    } catch {
      return null;
    }
  }

  async del(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await this.s3();
    await c.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
  }
}

export interface EnvDeStorage {
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_REGION?: string;
}

/**
 * Devuelve el almacenamiento configurado, o **null si no hay ninguno**.
 *
 * `null` no es un fallo: es el estado por defecto y significa «seguí bajando de Meta como
 * siempre». Hace falta bucket + las dos llaves; con una sola a medias no se intenta, porque
 * un storage que falla en cada escritura es peor que no tenerlo.
 */
export function crearStorage(env: EnvDeStorage): Storage | null {
  const bucket = (env.S3_BUCKET ?? "").trim();
  const accessKey = (env.S3_ACCESS_KEY ?? "").trim();
  const secretKey = (env.S3_SECRET_KEY ?? "").trim();
  if (!bucket || !accessKey || !secretKey) return null;
  return new S3Storage({
    bucket,
    accessKey,
    secretKey,
    endpoint: (env.S3_ENDPOINT ?? "").trim() || undefined,
    region: (env.S3_REGION ?? "").trim() || undefined,
  });
}

/** Extensión a partir del mime, para que el objeto se pueda abrir con doble clic. */
export function extensionDeMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("pdf")) return "pdf";
  const sub = m.split("/")[1]?.split(";")[0];
  return sub && /^[a-z0-9]{1,5}$/.test(sub) ? sub : "bin";
}

/**
 * La clave de un medio. Lleva la organización ADELANTE a propósito: así un listado por
 * prefijo, un borrado de tenant o una política del bucket pueden trabajar por organización
 * sin tener que mirar la base.
 */
export function claveDeMedio(organizationId: string, messageId: string, kind: string, mime: string): string {
  return `${organizationId}/${messageId}/${kind}.${extensionDeMime(mime)}`;
}

export * from "./medios.js";
