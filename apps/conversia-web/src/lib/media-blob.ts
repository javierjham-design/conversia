"use client";

import { useEffect, useRef, useState } from "react";
import { getToken } from "./api";
import { apiBase } from "./api-base";

/**
 * DESCARGAR UN MEDIO UNA SOLA VEZ, POR MÁS QUE EL HILO SE RECARGUE.
 *
 * El problema concreto: la bandeja escucha SSE y **recarga el hilo completo en cada evento**.
 * Si cada burbuja pidiera su archivo al montar, una conversación con 20 fotos volvería a
 * bajarlas enteras cada vez que llega un mensaje nuevo — y cada descarga pasa por nuestra API,
 * que a su vez la pide a Meta. Con una persona escribiendo seguido, eso es una tormenta.
 *
 * La caché vive en el MÓDULO (no en un contexto de React) a propósito: sobrevive al desmontaje
 * de las burbujas, que es justo lo que pasa en cada refetch. Lleva cuenta de cuántas burbujas
 * usan cada blob y lo libera cuando no queda ninguna **y además** pasó un rato: soltar el
 * `blob:` en el mismo instante en que se desmonta haría que el refetch siguiente volviera a
 * bajar todo, que es el problema que vinimos a resolver.
 *
 * El token NUNCA viaja en la URL. Va en la cabecera, como el resto del panel.
 */

export type EstadoDeMedio = "idle" | "loading" | "ready" | "expired" | "error";

interface Entrada {
  url: string | null;
  usos: number;
  /** Descarga en vuelo, para que dos burbujas no pidan lo mismo a la vez. */
  enVuelo: Promise<string> | null;
  liberarEn: ReturnType<typeof setTimeout> | null;
  expirado: boolean;
}

const cache = new Map<string, Entrada>();

/** Cuánto se conserva un blob sin usuarios antes de soltarlo. */
export const MS_ANTES_DE_LIBERAR = 10 * 60_000;

function entrada(clave: string): Entrada {
  let e = cache.get(clave);
  if (!e) {
    e = { url: null, usos: 0, enVuelo: null, liberarEn: null, expirado: false };
    cache.set(clave, e);
  }
  return e;
}

/** Marca de archivo que Meta ya borró: la UI lo explica, no lo trata como error. */
export class MedioExpirado extends Error {}

async function descargar(ruta: string): Promise<string> {
  const res = await fetch(apiBase() + ruta, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) {
    // La API manda {code: "MEDIA_EXPIRED"} cuando Meta ya no tiene el archivo (D2).
    const cuerpo = await res.json().catch(() => null);
    const code = (cuerpo as { code?: string; message?: { code?: string } } | null)?.code ?? (cuerpo as any)?.message?.code;
    if (res.status === 404 && code === "MEDIA_EXPIRED") throw new MedioExpirado();
    throw new Error(`No se pudo descargar el archivo (${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Pide el blob de una ruta, reutilizando el que ya exista. Expuesta para poder probarla. */
export async function obtenerBlob(ruta: string): Promise<string> {
  const e = entrada(ruta);
  if (e.expirado) throw new MedioExpirado();
  if (e.url) return e.url;
  if (!e.enVuelo) {
    e.enVuelo = descargar(ruta)
      .then((url) => {
        e.url = url;
        e.enVuelo = null;
        return url;
      })
      .catch((err) => {
        e.enVuelo = null;
        if (err instanceof MedioExpirado) e.expirado = true;
        throw err;
      });
  }
  return e.enVuelo;
}

function tomar(ruta: string) {
  const e = entrada(ruta);
  e.usos++;
  if (e.liberarEn) {
    clearTimeout(e.liberarEn);
    e.liberarEn = null;
  }
}

function soltar(ruta: string) {
  const e = cache.get(ruta);
  if (!e) return;
  e.usos = Math.max(0, e.usos - 1);
  if (e.usos > 0 || !e.url || e.liberarEn) return;
  e.liberarEn = setTimeout(() => {
    if (e.usos > 0) return;
    if (e.url) URL.revokeObjectURL(e.url);
    cache.delete(ruta);
  }, MS_ANTES_DE_LIBERAR);
}

/** Vacía la caché. Solo para tests. */
export function _limpiarCacheDeMedios() {
  for (const [, e] of cache) {
    if (e.liberarEn) clearTimeout(e.liberarEn);
    if (e.url) URL.revokeObjectURL(e.url);
  }
  cache.clear();
}

export interface MedioCargado {
  estado: EstadoDeMedio;
  url: string | null;
  /** Dispara la descarga. El audio y el video no bajan al montar: bajan al pulsar play. */
  cargar: () => void;
}

/**
 * `auto: true` baja el archivo al montar (fotos y stickers, que hay que VER).
 * `auto: false` espera a `cargar()` (audio y video: bajar un video que nadie reproduce es
 * gastar los datos del dueño).
 */
export function useMediaBlob(ruta: string | null, opts: { auto?: boolean } = {}): MedioCargado {
  const auto = opts.auto ?? true;
  const [estado, setEstado] = useState<EstadoDeMedio>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const pedido = useRef(false);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ruta) return;
    tomar(ruta);
    const yaEsta = cache.get(ruta)?.url ?? null;
    if (yaEsta) {
      setUrl(yaEsta);
      setEstado("ready");
      pedido.current = true;
    }
    return () => soltar(ruta);
  }, [ruta]);

  const cargar = () => {
    if (!ruta || pedido.current) return;
    pedido.current = true;
    setEstado("loading");
    obtenerBlob(ruta)
      .then((u) => {
        if (!vivo.current) return;
        setUrl(u);
        setEstado("ready");
      })
      .catch((e) => {
        if (!vivo.current) return;
        pedido.current = false; // permitir reintentar lo que no sea expiración
        setEstado(e instanceof MedioExpirado ? "expired" : "error");
      });
  };

  useEffect(() => {
    if (auto && ruta && !pedido.current) cargar();
    // `cargar` es estable para lo que importa acá (depende solo de `ruta`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, ruta]);

  return { estado, url, cargar };
}

/**
 * Un audio a la vez. Sin esto, abrir dos notas de voz deja las dos sonando encima — que es
 * exactamente lo que pasa con `<audio controls>` nativos sueltos.
 */
let reproduciendo: HTMLAudioElement | null = null;

export function registrarReproduccion(el: HTMLAudioElement) {
  if (reproduciendo && reproduciendo !== el) {
    try {
      reproduciendo.pause();
    } catch {
      /* el elemento pudo desmontarse */
    }
  }
  reproduciendo = el;
}

export function olvidarReproduccion(el: HTMLAudioElement) {
  if (reproduciendo === el) reproduciendo = null;
}
