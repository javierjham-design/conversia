"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Building2, CreditCard, LayoutDashboard, LogOut, Package, ShieldCheck } from "lucide-react";
import { clearPlatformToken, getPlatformToken } from "@/lib/platform-api";
import { ToastProvider, cn } from "@/components/ui";

const NAV = [
  { href: "/admin", label: "Resumen", icon: LayoutDashboard },
  { href: "/admin/organizations", label: "Organizaciones", icon: Building2 },
  { href: "/admin/plans", label: "Planes", icon: Package },
  { href: "/admin/billing", label: "Facturación", icon: CreditCard },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const isLogin = pathname === "/admin/login";

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!getPlatformToken()) {
      router.replace("/admin/login");
    } else {
      setReady(true);
    }
  }, [router, isLogin]);

  if (!ready) return null;
  if (isLogin) return <>{children}</>;

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden">
        <nav className="flex w-56 shrink-0 flex-col bg-navy-950 text-navy-200">
          <div className="flex items-center gap-2.5 border-b border-navy-800 px-4 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white">
              <ShieldCheck size={18} />
            </div>
            <div className="leading-tight">
              <p className="font-semibold text-white">Plataforma</p>
              <p className="text-[11px] text-navy-300">Conversia admin</p>
            </div>
          </div>
          <div className="flex-1 space-y-0.5 p-2">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
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
            onClick={() => {
              clearPlatformToken();
              window.location.href = "/admin/login";
            }}
            className="flex items-center gap-2.5 border-t border-navy-800 px-4 py-3 text-[13px] text-navy-300 hover:text-white"
          >
            <LogOut size={16} /> Cerrar sesión
          </button>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-slate-100">{children}</main>
      </div>
    </ToastProvider>
  );
}
