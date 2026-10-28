import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateOutboundUrl } from "@conversia/types";

/**
 * §7.3 — Segunda capa del guard anti-SSRF: RESOLVER el nombre y mirar a qué IP apunta.
 *
 * `validateOutboundUrl` mira el texto del host: bloquea `127.0.0.1`, `10.x`, `*.internal`…
 * Su propia nota lo dice: no re-resuelve DNS. Y ahí está el agujero, porque el host lo
 * elige quien escribe en el chat: `http://metadata.cualquier-dominio.cl` puede resolver a
 * `169.254.169.254` (las credenciales de la nube) o a un `10.x` de la red interna, y pasa
 * el filtro de texto sin problema. Además `redirect: "follow"` dejaba que el primer salto
 * fuera público y el segundo apuntara adentro: el guard ni se enteraba.
 *
 * LÍMITE CONOCIDO: entre resolver y conectar hay una ventana (DNS rebinding). Cerrarla
 * exige conectar a la IP ya verificada con un dispatcher propio de undici; no está hecho
 * y queda anotado. Lo que SÍ cierra esto es el caso real: un nombre que apunta adentro y
 * una cadena de redirecciones que termina adentro.
 */

/** Rangos IPv4 que nunca deben alcanzarse desde una URL que escribió un tercero. */
function esIPv4Prohibida(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // raro = no
  const [a, b] = o;
  if (a === 0) return true; // "this host"
  if (a === 10) return true; // privada
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local: metadatos de la nube
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 192 && b === 0) return true; // IETF protocol assignments / 192.0.2.x doc
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reservado + broadcast
  return false;
}

function esIPv6Prohibida(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (/^f[cd]/.test(v)) return true; // unique-local
  if (/^fe[89ab]/.test(v)) return true; // link-local
  if (/^ff/.test(v)) return true; // multicast
  // IPv4 mapeada/embebida (::ffff:127.0.0.1): se juzga por la parte v4.
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (m) return esIPv4Prohibida(m[1]);
  return false;
}

export function esIpProhibida(ip: string): boolean {
  const familia = isIP(ip);
  if (familia === 4) return esIPv4Prohibida(ip);
  if (familia === 6) return esIPv6Prohibida(ip);
  return true; // no es una IP → no se puede juzgar: no
}

/**
 * Valida una URL para salir a Internet: guard de texto + TODAS las IPs a las que resuelve
 * su host. Si cualquiera apunta adentro, se rechaza (basta una para que el ataque funcione).
 */
export async function validarUrlExterna(
  raw: string,
  deps: { resolver?: (host: string) => Promise<string[]> } = {},
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const base = validateOutboundUrl(raw);
  if (!base.ok) return base;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Si el host YA es una IP, el guard de texto la juzgó; igual se revisa con los rangos
  // completos (el de texto no cubre CGNAT, multicast ni IPv4 mapeada en IPv6).
  if (isIP(host)) {
    return esIpProhibida(host) ? { ok: false, reason: "La dirección apunta a una red interna" } : { ok: true, url };
  }

  const resolver =
    deps.resolver ?? (async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address));
  let direcciones: string[];
  try {
    direcciones = await resolver(host);
  } catch {
    return { ok: false, reason: "No se pudo resolver el dominio" };
  }
  if (!direcciones.length) return { ok: false, reason: "El dominio no resuelve a ninguna dirección" };
  // UNA sola IP interna basta para que el ataque funcione: se exige que TODAS sean públicas.
  if (direcciones.some((ip) => esIpProhibida(ip))) {
    return { ok: false, reason: "El dominio apunta a una red interna" };
  }
  return { ok: true, url };
}
