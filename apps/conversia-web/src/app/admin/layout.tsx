"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Building2, LogOut, ShieldCheck } from "lucide-react";
import { clearPlatformToken, getPlatformToken, padmin } from "@/lib/platform-api";

/**
 * Layout del SUPER ADMIN de Conversia. Guard de sesión + puerta de MFA (igual que TuBot):
 * sin token → login; con token pero sin MFA activo (si el backend lo exige) → a Seguridad
 * para enrolarlo. El login y Seguridad quedan accesibles sin la puerta para poder entrar
 * y enrolar. Navegación propia de consola (no la del panel de cliente).
 */
const NAV = [
  { href: "/admin", label: "Panel", Icon: BarChart3 },
  { href: "/admin/organizations", label: "Tenants", Icon: Building2 },
  { href: "/admin/security", label: "Seguridad", Icon: ShieldCheck },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/admin/login";
  const [ready, setReady] = useState(isLogin);

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
    padmin<{ mfaEnabled: boolean }>("/platform/auth/me")
      .then((me) => {
        if (!alive) return;
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
            <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>Consola</p>
          </div>
        </div>
        {NAV.map(({ href, label, Icon }) => (
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
