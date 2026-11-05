import { CalendarDays, CreditCard, Globe, Home, MessageCircle, Radio, Settings, Users, Wallet } from "lucide-react";
import type { ComponentType } from "react";

/**
 * LA TABLA DE NAVEGACIÓN — una sola fuente para el menú, el título de cada pantalla y las
 * pestañas.
 *
 * Por qué existe: el riel de la izquierda eran nueve iconos sin una palabra, y el texto del
 * menú no coincidía con el título de la pantalla a la que llevaba ("Mi página" → "Tu página
 * web"). Resultado: no se sabía a qué sección se estaba entrando, ni al llegar se confirmaba
 * que habías llegado. Y `/caja`, `/clientes`, `/mini-sitio` y `/ajustes` no se enlazan desde
 * ninguna otra pantalla: si el riel no se entiende, esas secciones quedan escondidas.
 *
 * El arreglo no es cosmético. Las pantallas ya NO escriben su título: lo piden acá con
 * `<EncabezadoSeccion ruta="/caja" />`. Así es imposible que el menú y el título digan cosas
 * distintas, porque no hay dos lugares donde escribirlo. `nav.test.ts` lo encierra.
 *
 * Sin directiva `"use client"` a propósito: lo consumen componentes de cliente, pero es
 * código puro y debe poder importarse desde cualquier lado.
 */

export type Pestana = { href: string; label: string };

export type Seccion = {
  href: string;
  /** EL nombre de la sección: el mismo texto en el menú y en el título de la pantalla. */
  label: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Una línea bajo el título. Explica para qué sirve la sección a quien llega por primera vez. */
  bajada?: string;
  /** Sub-pantallas de la sección, como pestañas bajo el título. */
  pestanas?: Pestana[];
};

export type Grupo = { titulo: string; items: Seccion[] };

/**
 * Los grupos no son decoración: el título del grupo es lo que distingue **Caja** (el dinero
 * del negocio del dueño) de **Cobros** (lo que Conversia le cobra a él). Hasta ahora eso se
 * aclaraba con un paréntesis dentro de la pantalla de Caja, que es parchar con texto un
 * problema de estructura.
 */
export const GRUPOS: Grupo[] = [
  {
    titulo: "Día a día",
    items: [
      { href: "/inicio", label: "Hoy", Icon: Home },
      { href: "/conversaciones", label: "Conversaciones", Icon: MessageCircle },
      {
        href: "/agenda",
        label: "Agenda",
        Icon: CalendarDays,
        // "Calendario" y no "Semana": dentro de la Agenda ya hay botones Día/Semana/Próximas
        // para la vista, y dos cosas distintas con el mismo nombre en la misma pantalla es
        // peor que no ponerle nombre a ninguna.
        pestanas: [
          { href: "/agenda", label: "Calendario" },
          { href: "/agenda/configurar", label: "Configurar" },
        ],
      },
      { href: "/clientes", label: "Clientes", Icon: Users, bajada: "Todos los contactos que te han escrito." },
    ],
  },
  {
    titulo: "Tu negocio",
    items: [
      {
        href: "/caja",
        label: "Caja",
        Icon: Wallet,
        bajada: "El dinero que entra y sale de tu negocio hoy.",
      },
      {
        href: "/mini-sitio",
        label: "Mi página web",
        Icon: Globe,
        bajada: "Una página simple de tu negocio, con botón de WhatsApp. Se arma sola; tú solo ajustas unos textos y la publicas.",
      },
    ],
  },
  {
    titulo: "Tu cuenta Conversia",
    items: [
      { href: "/cobros", label: "Cobros", Icon: CreditCard, bajada: "Tu saldo, tu plan y tus pagos a Conversia." },
      { href: "/canales", label: "Canales", Icon: Radio, bajada: "Conecta dónde conversan tus clientes contigo." },
      { href: "/ajustes", label: "Ajustes", Icon: Settings },
    ],
  },
];

export const SECCIONES: Seccion[] = GRUPOS.flatMap((g) => g.items);

/**
 * En móvil la barra inferior muestra 4 + "Más". Los 4 son EL GRUPO del día a día, no los
 * cuatro primeros de una lista plana: así el día que se agregue una sección de configuración
 * no se cuela sola en la barra.
 */
export const PRIMARIOS: Seccion[] = GRUPOS[0].items;
export const RESTO: Grupo[] = GRUPOS.slice(1);

/**
 * ¿Esta ruta pertenece a esta sección? Comparación por segmento, no `startsWith` pelado: el
 * anterior encendía `/caja` estando en `/cajafoo`.
 */
export function esActiva(pathname: string, href: string): boolean {
  if (href === "/inicio") return pathname === "/inicio";
  return pathname === href || pathname.startsWith(href + "/");
}

/** La sección a la que pertenece una ruta, o null si está fuera del panel (login, landing…). */
export function seccionActiva(pathname: string): Seccion | null {
  // De la más específica a la más general, por si alguna vez una ruta es prefijo de otra.
  return [...SECCIONES].sort((a, b) => b.href.length - a.href.length).find((s) => esActiva(pathname, s.href)) ?? null;
}

/** La pestaña activa: la MÁS específica que calza (en /agenda/configurar calzan las dos). */
export function pestanaActiva(pestanas: Pestana[] | undefined, pathname: string): Pestana | null {
  if (!pestanas?.length) return null;
  return [...pestanas].sort((a, b) => b.href.length - a.href.length).find((p) => esActiva(pathname, p.href)) ?? null;
}
