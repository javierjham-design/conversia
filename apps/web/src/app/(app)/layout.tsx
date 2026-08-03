"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Contact2,
  CreditCard,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Settings,
  Smartphone,
  Users,
  Workflow,
} from "lucide-react";
import { api, clearToken, getToken } from "@/lib/api";
import { HealthDot, ToastProvider, cn } from "@/components/ui";
import { ThemeToggle } from "@/components/theme";

interface Me {
  user: { id: string; email: string; name: string } | null;
  organization: { id: string; name: string; slug: string } | null;
  role: string;
  permissions: string[];
}

const MeContext = createContext<Me | null>(null);
export function useMe() {
  return useContext(MeContext);
}

/** Campana: incidencias de integraciones (token vencido, sync fallida, CAPI…). */
function NotificationsBell() {
  const [events, setEvents] = useState<{ id: string; provider: string; status: string; message: string | null; createdAt: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState<number>(() => Number(typeof window !== "undefined" ? localStorage.getItem("notifSeenAt") ?? 0 : 0));

  useEffect(() => {
    const load = () =>
      api<{ events: { id: string; provider: string; status: string; message: string | null; createdAt: string }[] }>("/integrations/notifications")
        .then((r) => setEvents(r.events))
        .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  const unread = events.filter((e) => new Date(e.createdAt).getTime() > seenAt).length;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          const now = Date.now();
          setSeenAt(now);
          localStorage.setItem("notifSeenAt", String(now));
        }}
        aria-label="Notificaciones"
        className="relative text-slate-500 hover:text-navy-900"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-50 w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
            <p className="px-2 py-1 text-xs font-medium text-slate-500">Incidencias de integraciones</p>
            {events.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-400">Sin incidencias recientes ✔</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {events.map((e) => (
                  <li key={e.id} className="rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50">
                    <span className={e.status === "error" ? "text-red-500" : "text-amber-500"}>●</span>{" "}
                    <span className="text-slate-600">{e.message ?? e.provider}</span>
                    <span className="block pl-3 text-[10px] text-slate-400">
                      {e.provider} · {new Date(e.createdAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <a href="/integrations" className="block px-2 py-1.5 text-[11px] text-cyan-700 hover:underline">
              Ver integraciones →
            </a>
          </div>
        </>
      )}
    </div>
  );
}

/** ¿El usuario tiene el permiso? owner/admin llevan "*". Espeja hasPermission del backend. */
export function can(perms: string[] | null | undefined, required: string): boolean {
  if (!perms) return false;
  if (perms.includes("*")) return true;
  if (perms.includes(required)) return true;
  return perms.includes(`${required.split(":")[0]}:*`);
}

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{
    href?: string;
    label: string;
    icon: React.ComponentType<{ size?: number | string; className?: string }>;
    soon?: boolean;
    perm?: string; // permiso requerido para ver el módulo (undefined = visible para todos)
  }>;
}> = [
  {
    label: "Operación",
    items: [
      { href: "/inbox", label: "Bandeja", icon: MessageSquare, perm: "inbox:read" },
      { href: "/contacts", label: "Contactos", icon: Contact2, perm: "contacts:read" },
      { label: "Agenda", icon: CalendarDays, soon: true },
    ],
  },
  {
    label: "Automatización",
    items: [
      { href: "/agents", label: "Agentes IA", icon: Bot, perm: "agents:read" },
      { href: "/workflows", label: "Flujos", icon: Workflow, perm: "workflows:read" },
    ],
  },
  {
    label: "Análisis",
    items: [{ href: "/reports", label: "Reportes", icon: BarChart3, perm: "reports:read" }],
  },
  {
    label: "Configuración",
    items: [
      { href: "/settings", label: "Configuración", icon: Settings, perm: undefined },
      { href: "/channels", label: "Canales", icon: Smartphone, perm: "channels:read" },
      { href: "/integrations", label: "Integraciones", icon: Plug, perm: "integrations:read" },
      { href: "/users", label: "Usuarios", icon: Users, perm: "users:read" },
      { href: "/billing", label: "Plan y facturación", icon: CreditCard, perm: "billing:read" },
    ],
  },
];

const BREADCRUMBS: Record<string, string[]> = {
  "/inbox": ["Operación", "Bandeja"],
  "/contacts": ["Operación", "Contactos"],
  "/agents": ["Automatización", "Agentes IA"],
  "/workflows": ["Automatización", "Flujos"],
  "/reports": ["Análisis", "Reportes"],
  "/channels": ["Configuración", "Canales"],
  "/integrations": ["Configuración", "Integraciones"],
  "/integrations/meta": ["Configuración", "Integraciones", "Meta Business Suite"],
  "/users": ["Configuración", "Usuarios"],
  "/settings": ["Configuración"],
  "/settings/profile": ["Configuración", "Mi perfil"],
  "/billing": ["Configuración", "Plan y facturación"],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  // Cierra el menú móvil al navegar.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setReady(true);
    setCollapsed(window.localStorage.getItem("conversia_nav_collapsed") === "1");
    void api<Me>("/auth/me").then(setMe).catch(() => undefined);
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    const check = () =>
      fetch("/backend/health").then((r) => setApiOk(r.ok)).catch(() => setApiOk(false));
    void check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [ready]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      window.localStorage.setItem("conversia_nav_collapsed", c ? "0" : "1");
      return !c;
    });
  }

  if (!ready) return null;

  const crumbs =
    BREADCRUMBS[pathname] ??
    BREADCRUMBS[Object.keys(BREADCRUMBS).filter((k) => pathname.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? ""] ??
    [];

  // Permisos del usuario para segmentar la navegación. null = aún cargando (muestra todo).
  const perms = me?.permissions ?? null;
  const canSee = (perm?: string) => !perm || perms === null || can(perms, perm);

  return (
    <ToastProvider>
      <MeContext.Provider value={me}>
        <div className="flex h-screen overflow-hidden">
          {/* Backdrop del drawer en móvil */}
          {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}
          {/* ------------------------------ Sidebar ------------------------------ */}
          <nav
            className={cn(
              "fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-navy-900 text-navy-200 transition-transform md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-200",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
              collapsed ? "md:w-[68px]" : "md:w-60",
            )}
            aria-label="Navegación principal"
          >
            {/* Marca */}
            <div className={cn("flex items-center gap-2.5 px-4 pb-4 pt-5", collapsed && "justify-center px-0")}>
              <img src="/brand/tubot-icon.png" alt="TuBot" className="h-9 w-9 shrink-0 object-contain" />
              {!collapsed && (
                <div className="leading-tight">
                  <p className="font-semibold tracking-tight text-white">TuBot</p>
                  <p className="text-[11px] text-navy-300">Atención conversacional</p>
                </div>
              )}
            </div>

            {/* Tenant activo */}
            {!collapsed && me?.organization && (
              <div className="mx-3 mb-2 rounded-lg bg-navy-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Building2 size={14} className="shrink-0 text-accent-400" />
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-[13px] font-medium text-white">{me.organization.name}</p>
                    <p className="text-[10px] uppercase tracking-wide text-navy-300">Entorno piloto</p>
                  </div>
                </div>
              </div>
            )}

            {/* Grupos */}
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {NAV_GROUPS.map((group) => {
                const items = group.items.filter((item) => canSee(item.perm));
                if (items.length === 0) return null;
                return (
                <div key={group.label} className="mb-1.5">
                  {!collapsed && (
                    <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-navy-300/70">
                      {group.label}
                    </p>
                  )}
                  {items.map((item) => {
                    const Icon = item.icon;
                    const active = item.href ? pathname.startsWith(item.href) : false;
                    if (!item.href) {
                      return (
                        <div
                          key={item.label}
                          title={collapsed ? `${item.label} (próximamente)` : undefined}
                          className={cn(
                            "flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] text-navy-300/50",
                            collapsed && "justify-center",
                          )}
                        >
                          <Icon size={17} />
                          {!collapsed && (
                            <span className="flex-1">
                              {item.label}{" "}
                              <span className="rounded bg-navy-800 px-1 py-0.5 text-[9px] uppercase text-navy-300/70">pronto</span>
                            </span>
                          )}
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        title={collapsed ? item.label : undefined}
                        className={cn(
                          "mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                          collapsed && "justify-center",
                          active
                            ? "bg-brand-600/20 text-white shadow-[inset_2px_0_0_0] shadow-accent-400"
                            : "text-navy-200 hover:bg-navy-800 hover:text-white",
                        )}
                      >
                        <Icon size={17} className={active ? "text-accent-400" : ""} />
                        {!collapsed && item.label}
                      </Link>
                    );
                  })}
                </div>
                );
              })}
            </div>

            {/* Pie: tema + colapsar + usuario */}
            <div className="border-t border-navy-800 p-2">
              <ThemeToggle collapsed={collapsed} />
              <button
                onClick={toggleCollapsed}
                className={cn(
                  "mb-1 mt-1 hidden w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-navy-300 hover:bg-navy-800 hover:text-white md:flex",
                  collapsed && "justify-center",
                )}
                aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
              >
                {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                {!collapsed && "Colapsar"}
              </button>
              <div className={cn("flex w-full items-center gap-1", collapsed && "justify-center")}>
                {/* Nombre/avatar → Mi perfil (configuración personal) */}
                {!collapsed && (
                  <a
                    href="/settings/profile"
                    title="Mi perfil"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-navy-300 hover:bg-navy-800 hover:text-white"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy-700 text-[10px] font-semibold text-white">
                      {(me?.user?.name ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{me?.user?.name ?? "Mi perfil"}</span>
                  </a>
                )}
                <button
                  onClick={() => {
                    clearToken();
                    window.location.href = "/login";
                  }}
                  title="Cerrar sesión"
                  className="rounded-lg px-2.5 py-2 text-navy-300 hover:bg-navy-800 hover:text-white"
                >
                  <LogOut size={16} />
                </button>
              </div>
            </div>
          </nav>

          {/* ------------------------------ Contenido ------------------------------ */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Barra superior */}
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 md:px-5">
              <div className="flex items-center gap-2">
                <button onClick={() => setMobileOpen(true)} aria-label="Abrir menú" className="text-navy-900 md:hidden">
                  <Menu size={22} />
                </button>
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-slate-400">
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 && <span aria-hidden>/</span>}
                      <span className={i === crumbs.length - 1 ? "font-medium text-slate-700" : ""}>{c}</span>
                    </span>
                  ))}
                </nav>
              </div>
              <div className="flex items-center gap-4">
                <NotificationsBell />
                <span className="flex items-center gap-1.5 text-xs text-slate-500" title="Estado del API">
                  <HealthDot level={apiOk === null ? "off" : apiOk ? "ok" : "error"} />
                  {apiOk === false ? "Sin conexión" : "Operativo"}
                </span>
                {me?.user && (
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white"
                    title={`${me.user.name} · ${me.role}`}
                  >
                    {me.user.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
          </div>
        </div>
      </MeContext.Provider>
    </ToastProvider>
  );
}
