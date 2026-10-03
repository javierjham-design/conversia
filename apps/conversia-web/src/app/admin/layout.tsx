"use client";
import { useEffect, useState, type ReactNode, type ComponentType } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity, AlertTriangle, BarChart3, Building2, CreditCard, LifeBuoy, LogOut, MessageSquare,
  Package, PackagePlus, Rocket, ScrollText, ShieldCheck, Ticket, UserCog, Users2,
} from "lucide-react";
import { clearPlatformToken, getPlatformToken, padmin } from "@/lib/platform-api";

/**
 * Layout de la CONSOLA de Conversia (super admin + F10 operador). Guard de sesión + puerta de
 * MFA; nav consciente del rol. El riel usa estilos PROPIOS (no la clase .nav-item del panel del
 * cliente, que es un riel de solo-iconos) → icono + etiqueta en fila, con grupos claros.
 */
type NavItem = { href: string; label: string; Icon: ComponentType<{ size?: number; strokeWidth?: number }> };
type NavGroup = { title: string; superOnly: boolean; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    title: "Operación",
    superOnly: false,
    items: [
      { href: "/admin", label: "Panel", Icon: BarChart3 },
      { href: "/admin/organizations", label: "Tenants", Icon: Building2 },
      { href: "/admin/alta", label: "Alta guiada", Icon: Rocket },
      { href: "/admin/demos", label: "Prospectos / CRM", Icon: Users2 },
      { href: "/admin/soporte", label: "Soporte", Icon: LifeBuoy },
    ],
  },
  {
    title: "Configuración",
    superOnly: true,
    items: [
      { href: "/admin/plans", label: "Planes", Icon: Package },
      { href: "/admin/mensajeria", label: "Mensajería y costos", Icon: MessageSquare },
      { href: "/admin/packages", label: "Paquetes", Icon: PackagePlus },
      { href: "/admin/coupons", label: "Cupones", Icon: Ticket },
      { href: "/admin/billing", label: "Facturación", Icon: CreditCard },
    ],
  },
  {
    title: "Sistema",
    superOnly: true,
    items: [
      { href: "/admin/alerts", label: "Alertas", Icon: AlertTriangle },
      { href: "/admin/audit", label: "Auditoría", Icon: ScrollText },
      { href: "/admin/infra", label: "Infraestructura", Icon: Activity },
      { href: "/admin/operadores", label: "Operadores", Icon: UserCog },
    ],
  },
  {
    title: "Cuenta",
    superOnly: false,
    items: [{ href: "/admin/security", label: "Seguridad", Icon: ShieldCheck }],
  },
];

const FULL_ROLES = new Set(["owner", "admin"]);

function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
}

/** Ítem del riel: fila icono + etiqueta, con estado activo claro (no reusa .nav-item). */
function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const { href, label, Icon } = item;
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        height: 38,
        padding: "0 12px",
        borderRadius: 10,
        fontSize: 14,
        textDecoration: "none",
        color: active ? "var(--acc-deep)" : "var(--ink-dim)",
        background: active ? "var(--acc-dim)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 var(--acc)" : "none",
        fontWeight: active ? 600 : 500,
      }}
    >
      <Icon size={18} strokeWidth={2} />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </a>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/admin/login";
  const [ready, setReady] = useState(isLogin);
  const [role, setRole] = useState<string>("owner");

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!getPlatformToken()) {
      router.replace("/admin/login");
      return;
    }
    let alive = true;
    padmin<{ mfaEnabled: boolean; admin?: { role?: string } }>("/platform/auth/me")
      .then((me) => {
        if (!alive) return;
        setRole(me.admin?.role ?? "owner");
        if (!me.mfaEnabled && pathname !== "/admin/security") {
          router.replace("/admin/security");
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!alive) return;
        clearPlatformToken();
        router.replace("/admin/login");
      });
    return () => {
      alive = false;
    };
  }, [isLogin, pathname, router]);

  if (isLogin) return <>{children}</>;
  if (!ready) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <p className="text-dim">Cargando…</p>
      </main>
    );
  }

  const isSuper = FULL_ROLES.has(role);

  function logout() {
    padmin("/platform/auth/logout", { method: "POST" }).catch(() => {});
    clearPlatformToken();
    router.replace("/admin/login");
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex" }}>
      <aside
        className="card"
        style={{
          width: 230,
          flexShrink: 0,
          borderRadius: 0,
          borderTop: "none",
          borderBottom: "none",
          borderLeft: "none",
          padding: "16px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          position: "sticky",
          top: 0,
          height: "100dvh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 14px" }}>
          <div className="shell-brand" style={{ width: 34, height: 34, fontSize: 17, marginBottom: 0 }}>C</div>
          <div>
            <p className="display" style={{ margin: 0, fontSize: 16, lineHeight: 1 }}>Conversia</p>
            <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>{isSuper ? "Consola · super admin" : "Consola · operador"}</p>
          </div>
        </div>

        {GROUPS.filter((g) => isSuper || !g.superOnly).map((g) => (
          <div key={g.title} style={{ marginTop: 10 }}>
            <p className="text-dim" style={{ margin: "0 0 4px", padding: "0 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.6 }}>{g.title}</p>
            {g.items.map((item) => (
              <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
            ))}
          </div>
        ))}

        <button
          onClick={logout}
          style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 11, width: "100%", height: 38, padding: "0 12px", borderRadius: 10, fontSize: 14, border: "none", background: "transparent", color: "var(--ink-dim)", cursor: "pointer" }}
        >
          <LogOut size={18} strokeWidth={2} />
          <span>Salir</span>
        </button>
      </aside>
      <div style={{ flex: 1, minWidth: 0, padding: "28px clamp(16px, 4vw, 44px)" }}>{children}</div>
    </div>
  );
}
