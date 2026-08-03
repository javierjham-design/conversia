"use client";

/**
 * Centro de Configuración del tenant — layout con sidebar propio de dos
 * niveles (grupos → páginas), búsqueda y visibilidad por rol (el servidor
 * igualmente valida permisos en cada endpoint).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ExternalLink, Search, Settings } from "lucide-react";
import { can, useMe } from "../layout";
import { cn } from "@/components/ui";

interface PageDef {
  href: string;
  label: string;
  /** sinónimos para la búsqueda */
  keywords: string;
  /** permiso requerido para VER la página (server-side valida igual) */
  perm?: string;
  ready?: boolean;
  external?: boolean;
}

const GROUPS: { title: string; pages: PageDef[] }[] = [
  {
    title: "Ajustes generales",
    pages: [
      { href: "/settings/general", label: "Información general", keywords: "nombre negocio logo rubro zona horaria moneda idioma empresa", perm: "settings:write", ready: true },
      { href: "/settings/hours", label: "Horario de atención", keywords: "horario dias feriados atencion apertura", perm: "settings:write" },
      { href: "/settings/plan", label: "Plan y uso", keywords: "plan consumo tokens mensajes facturacion límites uso", perm: "settings:write" },
    ],
  },
  {
    title: "Usuarios y equipos",
    pages: [
      { href: "/settings/users", label: "Usuarios", keywords: "usuarios invitar roles permisos acceso miembros", perm: "users:read" },
      { href: "/settings/teams", label: "Equipos", keywords: "equipos ventas recepcion sede grupos", perm: "users:read" },
    ],
  },
  {
    title: "Bandeja y CRM",
    pages: [
      { href: "/settings/lifecycle", label: "Etapas del ciclo de vida", keywords: "etapas ciclo vida lifecycle lead estados embudo funnel conversion", perm: "leads:write" },
      { href: "/settings/contact-fields", label: "Campos de contacto", keywords: "campos personalizados custom fields ficha columnas", perm: "contacts:write" },
      { href: "/settings/tags", label: "Etiquetas", keywords: "tags etiquetas fusionar colores", perm: "contacts:write" },
      { href: "/settings/snippets", label: "Respuestas rápidas", keywords: "snippets respuestas rapidas atajos plantillas texto", perm: "inbox:write" },
      { href: "/settings/conversations", label: "Conversaciones", keywords: "bandeja auto cierre inactividad bot primera respuesta reglas", perm: "settings:write" },
    ],
  },
  {
    title: "IA",
    pages: [
      { href: "/settings/ia", label: "Ajustes de IA", keywords: "ia modelo tokens transcripcion idioma prompts plantillas asistente", perm: "settings:write" },
      { href: "/agents", label: "Agentes IA", keywords: "agentes bots", external: true, ready: true },
    ],
  },
  {
    title: "Datos",
    pages: [
      { href: "/settings/import", label: "Importar contactos", keywords: "importar csv excel contactos migracion", perm: "contacts:write" },
      { href: "/settings/export", label: "Exportar datos", keywords: "exportar descargar csv conversaciones citas respaldo", perm: "settings:write" },
      { href: "/settings/audit", label: "Registro de auditoría", keywords: "auditoria logs seguridad quien hizo que", perm: "settings:write" },
    ],
  },
  {
    title: "Canales e integraciones",
    pages: [
      { href: "/channels", label: "Canales (WhatsApp)", keywords: "canales whatsapp numeros", external: true, ready: true },
      { href: "/integrations", label: "Integraciones", keywords: "integraciones google hubspot dentalink capi", external: true, ready: true },
    ],
  },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const me = useMe();
  const [q, setQ] = useState("");
  const perms = me?.permissions ?? null;
  const visible = (p: PageDef) => !p.perm || perms === null || can(perms, p.perm);
  const matches = (p: PageDef) => !q.trim() || `${p.label} ${p.keywords}`.toLowerCase().includes(q.trim().toLowerCase());

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 p-3">
          <h1 className="flex items-center gap-1.5 text-sm font-semibold">
            <Settings size={15} /> Configuración
          </h1>
          <div className="relative mt-2">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar ajuste…"
              className="w-full rounded-lg border border-slate-300 py-1.5 pl-7 pr-2 text-xs"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {GROUPS.map((g) => {
            const pages = g.pages.filter((p) => visible(p) && matches(p));
            if (!pages.length) return null;
            return (
              <div key={g.title} className="mb-3">
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{g.title}</p>
                {pages.map((p) =>
                  p.ready === false || (!p.ready && !p.external) ? (
                    <span key={p.href} className="flex cursor-default items-center gap-1 px-3 py-1.5 text-[13px] text-slate-300" title="Disponible pronto">
                      {p.label}
                      <span className="rounded bg-slate-100 px-1 text-[9px] text-slate-400">pronto</span>
                    </span>
                  ) : (
                    <Link
                      key={p.href}
                      href={p.href}
                      className={cn(
                        "flex items-center gap-1 px-3 py-1.5 text-[13px]",
                        pathname === p.href ? "bg-cyan-50 font-medium text-cyan-800" : "text-slate-600 hover:bg-slate-50",
                      )}
                    >
                      {p.label}
                      {p.external && <ExternalLink size={11} className="text-slate-400" />}
                    </Link>
                  ),
                )}
              </div>
            );
          })}
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50">{children}</main>
    </div>
  );
}
