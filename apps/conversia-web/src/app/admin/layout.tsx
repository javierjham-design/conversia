"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Building2, LifeBuoy, LogOut, Rocket, ShieldCheck, UserCog } from "lucide-react";
import { clearPlatformToken, getPlatformToken, padmin } from "@/lib/platform-api";

/**
 * Layout de la CONSOLA de Conversia (super admin + F10 operador). Guard de sesión + puerta
 * de MFA (igual que TuBot): sin token → login; con token pero sin MFA activo → a Seguridad
 * para enrolarlo (el operador TAMBIÉN debe enrolar MFA). El nav es consciente del rol: el
 * operador opera la ficha de clientes y el alta guiada, pero "Operadores" (gestionar al
 * equipo) es solo del super admin. El backend bloquea además cualquier ruta global (denylist).
 */
const BASE_NAV = [
  { href: "/admin", label: "Panel", Icon: BarChart3 },
  { href: "/admin/organizations", label: "Tenants", Icon: Building2 },
  { href: "/admin/alta", label: "Alta guiada", Icon: Rocket },
  { href: "/admin/soporte", label: "Soporte", Icon: LifeBuoy },
  { href: "/admin/security", label: "Seguridad", Icon: ShieldCheck },
];
const SUPER_ADMIN_NAV = [{ href: "/admin/operadores", label: "Operadores", Icon: UserCog }];
const FULL_ROLES = new Set(["owner", "admin"]);

function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
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
        // Puerta de MFA: si no está activo, el backend bloquea el resto del panel → a Seguridad.
        if (!me.mfaEnabled && pathname !== "/admin/security") {
          router.replace("/admin/security");
          return;
        }
        setReady(true);
      })
      .catch(() => {
        /* 401 → padmin ya redirige al login */
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
          width: 212,
          borderRadius: 0,
          borderTop: "none",
          borderBottom: "none",
          borderLeft: "none",
          padding: "18px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          position: "sticky",
          top: 0,
          height: "100dvh",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 16px" }}>
          <div className="shell-brand" style={{ width: 34, height: 34, fontSize: 17, marginBottom: 0 }}>C</div>
          <div>
            <p className="display" style={{ margin: 0, fontSize: 16, lineHeight: 1 }}>Conversia</p>
            <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>{FULL_ROLES.has(role) ? "Consola · super admin" : "Consola · operador"}</p>
          </div>
        </div>
        {[...BASE_NAV, ...(FULL_ROLES.has(role) ? SUPER_ADMIN_NAV : [])].map(({ href, label, Icon }) => (
          <a
            key={href}
            href={href}
            className={isActive(pathname, href) ? "nav-item active" : "nav-item"}
            style={{ width: "100%", height: 42, justifyContent: "flex-start", gap: 12, padding: "0 12px", fontSize: 14 }}
          >
            <Icon size={18} strokeWidth={2} />
            <span>{label}</span>
          </a>
        ))}
        <button
          onClick={logout}
          className="nav-item"
          style={{ marginTop: "auto", width: "100%", height: 42, justifyContent: "flex-start", gap: 12, padding: "0 12px", fontSize: 14, border: "none", background: "transparent", cursor: "pointer" }}
        >
          <LogOut size={18} strokeWidth={2} />
          <span>Salir</span>
        </button>
      </aside>
      <div style={{ flex: 1, minWidth: 0, padding: "28px clamp(16px, 4vw, 44px)" }}>{children}</div>
    </div>
  );
}
