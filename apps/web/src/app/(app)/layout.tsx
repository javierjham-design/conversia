"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
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
  KanbanSquare,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Rocket,
  Settings,
  ShoppingBag,
  Smartphone,
  Workflow,
} from "lucide-react";
import { api, clearToken, getToken } from "@/lib/api";
import { disablePush, enablePush, permissionState, pushSupport, registerServiceWorker } from "@/lib/push";
import { HealthDot, ToastProvider, cn } from "@/components/ui";
import { ThemeToggle } from "@/components/theme";
import { BillingBanner } from "@/components/BillingBanner";
import { OnboardingBanner } from "@/components/OnboardingBanner";
import { SupportWidget } from "@/components/SupportWidget";
import { PwaManager } from "@/components/PwaManager";
import { NotificationsPrompt } from "@/components/NotificationsPrompt";
import { OrgSwitcher } from "@/components/OrgSwitcher";

interface Me {
  user: { id: string; email: string; name: string } | null;
  organization: { id: string; name: string; slug: string } | null;
  role: string;
  permissions: string[];
  personalization?: {
    industry: string;
    vocabulary: Record<string, string>;
    modules: Record<string, boolean>;
  };
}

const MeContext = createContext<Me | null>(null);
export function useMe() {
  return useContext(MeContext);
}
/** Etiqueta traducida por rubro: `useTerm()("contacts")` → "Pacientes"/"Clientes"… */
export function useTerm() {
  const me = useContext(MeContext);
  const vocab = me?.personalization?.vocabulary;
  return (key: string, fallback: string) => (vocab && vocab[key]) || fallback;
}

interface NotifItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Campana unificada: eventos del sistema (asignaciones, escalamientos, citas…). */
function NotificationsBell() {
  const router = useRouter();
  const [items, setItems] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [pushCta, setPushCta] = useState<"hidden" | "offer" | "ios-install">("hidden");

  const load = useCallback(
    () =>
      api<{ unread: number; items: NotifItem[] }>("/notifications")
        .then((r) => {
          setItems(r.items);
          setUnread(r.unread);
        })
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    void registerServiceWorker();
    void load();
    const t = setInterval(() => void load(), 60_000);
    // ¿Ofrecer activar push? Solo si el permiso está en "default" y no lo descartó.
    const dismissed = localStorage.getItem("pushCtaDismissed") === "1";
    const support = pushSupport();
    if (!dismissed && permissionState() === "default") {
      setPushCta(support.supported ? "offer" : support.reason === "ios-needs-install" ? "ios-install" : "hidden");
    }
    return () => clearInterval(t);
  }, [load]);

  async function openBell() {
    setOpen((o) => !o);
    if (!open && unread > 0) {
      await api("/notifications/read", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    }
  }

  async function activatePush() {
    const toast = (window as any);
    const res = await enablePush();
    if (res.status === "granted") setPushCta("hidden");
    else if (res.status === "denied") {
      setPushCta("hidden");
      localStorage.setItem("pushCtaDismissed", "1");
    }
    void toast;
  }

  return (
    <div className="relative">
      <button onClick={() => void openBell()} aria-label="Notificaciones" className="relative text-ink-muted hover:text-ink">
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
          <div className="absolute right-0 top-8 z-50 w-80 rounded-xl border border-line bg-panel p-2 shadow-xl">
            {pushCta !== "hidden" && (
              <div className="mb-1 rounded-lg border border-line bg-app p-2 text-[11px]">
                {pushCta === "offer" ? (
                  <>
                    <p className="mb-1.5 text-ink-muted">Recibe avisos aunque no tengas el panel abierto (asignaciones, escalamientos…).</p>
                    <div className="flex gap-2">
                      <button onClick={() => void activatePush()} className="rounded-md bg-brand-600 px-2 py-1 font-medium text-white hover:bg-brand-700">
                        Activar notificaciones
                      </button>
                      <button
                        onClick={() => {
                          setPushCta("hidden");
                          localStorage.setItem("pushCtaDismissed", "1");
                        }}
                        className="px-2 py-1 text-ink-subtle hover:text-ink"
                      >
                        Ahora no
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-ink-muted">
                    Para recibir avisos en iPhone, instala TuBot: <b>Compartir → Agregar a inicio</b>.
                  </p>
                )}
              </div>
            )}
            <p className="px-2 py-1 text-xs font-medium text-ink-muted">Notificaciones</p>
            {items.length === 0 ? (
              <p className="px-2 py-3 text-xs text-ink-subtle">Sin notificaciones ✔</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        if (n.link) router.push(n.link);
                      }}
                      className={cn("block w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-app", !n.readAt && "bg-brand-600/5")}
                    >
                      <span className="font-medium text-ink">{n.title}</span>
                      {n.body && <span className="block text-ink-muted">{n.body}</span>}
                      <span className="block text-[10px] text-ink-subtle">
                        {new Date(n.createdAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <a href="/integrations" className="block px-2 py-1.5 text-[11px] text-brand-700 hover:underline dark:text-brand-300">
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
    term?: string; // clave de vocabulario por rubro (reemplaza label)
    moduleKey?: string; // si el módulo está desactivado por rubro, se oculta
    // Sub-vistas (B1): al estar activo el ítem, se despliegan debajo y cada una
    // se ilumina según ?vista. Ej. Clientes → Lista | Embudo.
    subs?: Array<{ vista: string; label: string }>;
  }>;
}> = [
  {
    label: "Inicio",
    items: [{ href: "/onboarding", label: "Primeros pasos", icon: Rocket }],
  },
  {
    label: "Operación",
    items: [
      { href: "/inbox", label: "Bandeja", icon: MessageSquare, perm: "inbox:read" },
      {
        href: "/contacts",
        label: "Clientes",
        icon: Contact2,
        perm: "contacts:read",
        term: "contacts",
        subs: [
          { vista: "lista", label: "Lista" },
          { vista: "embudo", label: "Embudo" },
        ],
      },
      { href: "/catalog", label: "Catálogo", icon: ShoppingBag, perm: "integrations:read" },
      { label: "Agenda", icon: CalendarDays, soon: true, moduleKey: "agenda" },
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
      // "Usuarios" vive en Configuración → Usuarios y equipos (la ruta /users
      // redirige allá); se quitó del menú principal por duplicado (B1.2).
      { href: "/billing", label: "Plan y facturación", icon: CreditCard, perm: "billing:read" },
    ],
  },
];

const BREADCRUMBS: Record<string, string[]> = {
  "/onboarding": ["Inicio", "Primeros pasos"],
  "/onboarding/plantillas": ["Inicio", "Primeros pasos", "Plantillas"],
  "/inbox": ["Operación", "Bandeja"],
  "/contacts": ["Operación", "Clientes"],
  "/crm": ["Operación", "Clientes"],
  "/agents": ["Automatización", "Agentes IA"],
  "/workflows": ["Automatización", "Flujos"],
  "/reports": ["Análisis", "Reportes"],
  "/channels": ["Configuración", "Canales"],
  "/integrations": ["Configuración", "Integraciones"],
  "/integrations/meta": ["Configuración", "Integraciones", "Meta Business Suite"],
  "/integrations/meta-crm": ["Configuración", "Integraciones", "Meta CRM (Lead Ads)"],
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
  // Cuenta suspendida (impago o prueba vencida): se esconde el menú lateral y
  // Facturación queda como única vista (BillingBanner además redirige allí).
  const [billingLocked, setBillingLocked] = useState(false);

  // Vista activa de Clientes (?vista) para iluminar el sub-ítem correcto (B1).
  // Se recalcula cuando cambia la ruta o cuando el conmutador emite «vistachange».
  const [navTick, setNavTick] = useState(0);
  useEffect(() => {
    const bump = () => setNavTick((n) => n + 1);
    window.addEventListener("vistachange", bump);
    window.addEventListener("popstate", bump);
    return () => {
      window.removeEventListener("vistachange", bump);
      window.removeEventListener("popstate", bump);
    };
  }, []);
  const activeVista = (() => {
    if (typeof window === "undefined") return "lista";
    void navTick; // fuerza recomputo al cambiar
    const v = new URLSearchParams(window.location.search).get("vista");
    return v === "embudo" || v === "tablero" ? "embudo" : "lista";
  })();

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

  const rawCrumbs =
    BREADCRUMBS[pathname] ??
    BREADCRUMBS[Object.keys(BREADCRUMBS).filter((k) => pathname.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? ""] ??
    [];
  // El vocabulario del tenant es la fuente única: el breadcrumb usa el mismo
  // término que el menú (B2 — «Clientes»/«Pacientes»/… según el rubro).
  const crumbVocab = me?.personalization?.vocabulary as Record<string, string> | undefined;
  const crumbs = rawCrumbs.map((c) => (c === "Clientes" && crumbVocab?.contacts ? crumbVocab.contacts : c));

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
              billingLocked && "!hidden",
            )}
            aria-label="Navegación principal"
          >
            {/* Marca: wordmark compacto (una sola línea). La bajada de marketing
                sale del chrome (B6) para no competir con el nombre de la
                organización que va justo debajo. */}
            <div className={cn("flex items-center gap-2.5 px-4 pb-3 pt-5", collapsed && "justify-center px-0")}>
              <img src="/brand/tubot-icon.png" alt="TuBot" className="h-8 w-8 shrink-0 object-contain" />
              {!collapsed && <p className="t-section text-white">TuBot</p>}
            </div>

            {/* Tenant activo + selector (si el usuario pertenece a varias orgs) */}
            {!collapsed && me?.organization && <OrgSwitcher currentName={me.organization.name} />}

            {/* Grupos */}
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {NAV_GROUPS.map((group) => {
                const modules = me?.personalization?.modules ?? {};
                const vocab = me?.personalization?.vocabulary ?? {};
                const items = group.items.filter(
                  (item) => canSee(item.perm) && (!item.moduleKey || modules[item.moduleKey] !== false),
                );
                if (items.length === 0) return null;
                const labelOf = (item: (typeof group.items)[number]) => (item.term && vocab[item.term]) || item.label;
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
                      <div key={item.href}>
                        <Link
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
                          {!collapsed && labelOf(item)}
                        </Link>
                        {/* Sub-vistas (B1): visibles cuando el ítem está activo */}
                        {item.subs && active && !collapsed && (
                          <div className="mb-1 ml-4 border-l border-navy-800 pl-2">
                            {item.subs.map((s) => {
                              const on = activeVista === s.vista;
                              return (
                                <Link
                                  key={s.vista}
                                  href={`${item.href}?vista=${s.vista}`}
                                  onClick={() => setMobileOpen(false)}
                                  className={cn(
                                    "block rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors",
                                    on ? "font-medium text-white" : "text-navy-300 hover:bg-navy-800 hover:text-white",
                                  )}
                                >
                                  {s.label}
                                </Link>
                              );
                            })}
                          </div>
                        )}
                      </div>
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
                  onClick={async () => {
                    await disablePush().catch(() => {});
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
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-4 md:px-5">
              <div className="flex items-center gap-2">
                {!billingLocked && (
                  <button onClick={() => setMobileOpen(true)} aria-label="Abrir menú" className="text-ink md:hidden">
                    <Menu size={22} />
                  </button>
                )}
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-ink-subtle">
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 && <span aria-hidden>/</span>}
                      <span className={i === crumbs.length - 1 ? "font-medium text-ink" : ""}>{c}</span>
                    </span>
                  ))}
                </nav>
              </div>
              <div className="flex items-center gap-4">
                <NotificationsBell />
                <span className="flex items-center gap-1.5 text-xs text-ink-muted" title="Estado del API">
                  <HealthDot level={apiOk === null ? "off" : apiOk ? "ok" : "error"} />
                  {apiOk === false ? "Sin conexión" : "Operativo"}
                </span>
                {me?.user && (
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white"
                    title={`${me.user.name ?? me.user.email} · ${me.role}`}
                  >
                    {(me.user.name ?? me.user.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
            </header>

            <BillingBanner onLocked={setBillingLocked} />
            {!billingLocked && <OnboardingBanner />}
            <main className="min-h-0 flex-1 overflow-hidden bg-app text-ink">{children}</main>
          </div>
          <SupportWidget />
          <PwaManager />
          <NotificationsPrompt />
        </div>
      </MeContext.Provider>
    </ToastProvider>
  );
}
