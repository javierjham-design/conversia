import { validateOutboundUrl } from "@conversia/types";

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
export async function fetchWebPageText(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {},
): Promise<WebPageResult> {
  let url = (rawUrl ?? "").trim();
  if (!url) return { ok: false, error: "URL vacía" };
  if (!/^https?:\/\//i.test(url)) url = "https://" + url; // acepta "clinica.cl"
  const guard = validateOutboundUrl(url);
  if (!guard.ok) return { ok: false, error: guard.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; TuBot/1.0; +https://tubot.cl)",
        accept: "text/html,application/xhtml+xml,text/plain",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype)) {
      return { ok: false, error: `Contenido no legible (${ctype || "desconocido"})` };
    }
    const raw = (await res.text()).slice(0, 800_000); // tope de descarga
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || null;
    const text = extractText(raw).slice(0, opts.maxChars ?? 4000);
    if (!text) return { ok: false, error: "La página no tiene texto legible" };
    return { ok: true, url, title, text };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "AbortError" ? "La página tardó demasiado en responder" : err.message.slice(0, 150) };
  } finally {
    clearTimeout(timer);
  }
}
