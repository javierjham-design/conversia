import { validarUrlExterna } from "./ssrf-guard.js";

export type WebPageResult =
  | { ok: true; url: string; title: string | null; text: string }
  | { ok: false; error: string };

/** Quita scripts/estilos/tags y decodifica entidades básicas → texto legible. */
function extractText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Descarga una página web y devuelve su TÍTULO + texto legible (acotado). Uso: que el
 * agente analice el sitio de un prospecto/cliente. Seguridad: valida la URL con el guard
 * anti-SSRF compartido (solo https públicas; nada de localhost/IPs privadas/hosts internos),
 * timeout, límite de tamaño, y solo procesa contenido de texto/HTML. Nunca navega ni envía nada.
 */
/** Tope DURO de bytes leídos del cuerpo (se corta el stream, no se descarga y luego recorta). */
const MAX_BYTES = 800_000;
/** Saltos de redirección permitidos. Cada uno se vuelve a validar. */
const MAX_REDIRECTS = 5;

/**
 * Lee el cuerpo con tope de BYTES, cortando el stream.
 *
 * §7.3 — antes era `(await res.text()).slice(0, 800_000)`: el `slice` recorta DESPUÉS de
 * haber traído todo a memoria, así que una respuesta de gigabytes (o infinita) se
 * descargaba entera antes de recortarse. Acá se deja de leer al llegar al tope.
 */
async function leerConTope(res: Response, maxBytes = MAX_BYTES): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const resto = maxBytes - total;
      if (value.byteLength >= resto) {
        trozos.push(value.subarray(0, resto));
        total += resto;
        break;
      }
      trozos.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const t of trozos) {
    buf.set(t, off);
    off += t.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export async function fetchWebPageText(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number; fetchImpl?: typeof fetch; resolver?: (host: string) => Promise<string[]> } = {},
): Promise<WebPageResult> {
  let url = (rawUrl ?? "").trim();
  if (!url) return { ok: false, error: "URL vacía" };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url; // acepta "clinica.cl"

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    let actual = url;
    let res: Response | null = null;
    // §7.3 — `redirect: "manual"` + validar CADA salto. Antes, con `follow`, solo se
    // validaba la URL inicial: bastaba que un dominio público respondiera 302 hacia
    // `http://169.254.169.254/` (metadatos de la nube) o a un `10.x` interno para que el
    // guard quedara fuera de juego.
    for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
      const guard = await validarUrlExterna(actual, { resolver: opts.resolver });
      if (!guard.ok) return { ok: false, error: guard.reason };
      res = await doFetch(actual, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; TuBot/1.0; +https://tubot.cl)",
          accept: "text/html,application/xhtml+xml,text/plain",
        },
      });
      if (res.status < 300 || res.status > 399) break;
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: `HTTP ${res.status} sin destino de redirección` };
      if (salto === MAX_REDIRECTS) return { ok: false, error: "Demasiadas redirecciones" };
      // Relativo o absoluto: se resuelve contra el salto actual y vuelve a pasar el guard.
      try {
        actual = new URL(location, actual).toString();
      } catch {
        return { ok: false, error: "Redirección con destino inválido" };
      }
    }
    if (!res) return { ok: false, error: "No se pudo leer la página" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) {
      return { ok: false, error: `Contenido no legible (${ctype || "desconocido"})` };
    }
    const raw = await leerConTope(res);
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || null;
    const text = extractText(raw).slice(0, opts.maxChars ?? 4000);
    if (!text) return { ok: false, error: "La página no tiene texto legible" };
    // Se devuelve la URL FINAL (tras las redirecciones validadas), no la que se pidió.
    return { ok: true, url: actual, title, text };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "AbortError" ? "La página tardó demasiado en responder" : err.message.slice(0, 150) };
  } finally {
    clearTimeout(timer);
  }
}
