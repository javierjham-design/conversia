"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, Building2, Calculator, CreditCard, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Menu, Package, Rocket, ScrollText, ShieldCheck, Ticket, X } from "lucide-react";
import { clearPlatformToken, getPlatformToken, padmin } from "@/lib/platform-api";
import { ToastProvider, cn } from "@/components/ui";

const NAV = [
  { href: "/admin", label: "Resumen", icon: LayoutDashboard },
  { href: "/admin/organizations", label: "Organizaciones", icon: Building2 },
  { href: "/admin/demos", label: "Demos / CRM", icon: Rocket },
  { href: "/admin/plans", label: "Planes", icon: Package },
  { href: "/admin/calculator", label: "Calculadora de costos", icon: Calculator },
  { href: "/admin/coupons", label: "Cupones", icon: Ticket },
  { href: "/admin/billing", label: "Facturación", icon: CreditCard },
  { href: "/admin/alerts", label: "Alertas", icon: AlertTriangle },
  { href: "/admin/support", label: "Soporte", icon: LifeBuoy },
  { href: "/admin/security", label: "Seguridad", icon: KeyRound },
  { href: "/admin/audit", label: "Auditoría", icon: ScrollText },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(true);

  const isLogin = pathname === "/admin/login";
  const isSecurity = pathname === "/admin/security";

  // Cierra el menú móvil al navegar.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!getPlatformToken()) {
      router.replace("/admin/login");
      return;
    }
    // MFA obligatorio: si no está activo, solo se puede estar en /admin/security
    // (para enrolarlo). El backend además bloquea el resto de /platform/*.
    void padmin<{ mfaEnabled: boolean }>("/platform/auth/me")
      .then((me) => {
        setMfaEnabled(me.mfaEnabled);
        if (!me.mfaEnabled && !isSecurity) {
          router.replace("/admin/security");
          return;
        }
        setReady(true);
      })
      .catch(() => setReady(true));
  }, [router, isLogin, isSecurity]);

  if (!ready) return null;
  if (isLogin) return <>{children}</>;

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        {/* Backdrop del drawer en móvil */}
        {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />}

        {/* Sidebar: drawer en móvil, estático en desktop */}
        <nav
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-navy-950 text-navy-200 transition-transform lg:static lg:z-auto lg:w-56 lg:translate-x-0",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex items-center gap-2.5 border-b border-navy-800 px-4 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white">
              <ShieldCheck size={18} />
            </div>
            <div className="leading-tight">
              <p className="font-semibold text-white">Plataforma</p>
              <p className="text-[11px] text-navy-300">TuBot admin</p>
            </div>
            <button onClick={() => setMobileOpen(false)} className="ml-auto text-navy-300 hover:text-white lg:hidden" aria-label="Cerrar menú">
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium",
                    active ? "bg-brand-600/20 text-white shadow-[inset_2px_0_0_0] shadow-accent-400" : "text-navy-200 hover:bg-navy-800 hover:text-white",
                  )}
                >
                  <Icon size={17} className={active ? "text-accent-400" : ""} />
                  {item.label}
                </Link>
              );
            })}
          </div>
          <button
            onClick={async () => {
              // Revoca la sesión en el servidor (Redis) antes de limpiar el token local.
              await padmin("/platform/auth/logout", { method: "POST" }).catch(() => {});
              clearPlatformToken();
              window.location.href = "/admin/login";
            }}
            className="flex items-center gap-2.5 border-t border-navy-800 px-4 py-3 text-[13px] text-navy-300 hover:text-white"
          >
            <LogOut size={16} /> Cerrar sesión
          </button>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Barra superior con hamburguesa (solo móvil) */}
          <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
            <button onClick={() => setMobileOpen(true)} aria-label="Abrir menú" className="text-navy-900">
              <Menu size={22} />
            </button>
            <span className="font-semibold text-navy-900">TuBot admin</span>
          </div>
          {!mfaEnabled && (
            <div className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
              <ShieldCheck size={16} className="shrink-0" />
              <span>
                <b>Activa la autenticación en dos pasos (MFA)</b> para desbloquear el panel. Es
                obligatoria: protege el acceso total a la plataforma.
              </span>
            </div>
          )}
          <main className="min-w-0 flex-1 overflow-y-auto bg-slate-100">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
