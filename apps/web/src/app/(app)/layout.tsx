"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, getToken } from "@/lib/api";

const NAV = [
  { href: "/inbox", label: "Bandeja", icon: "💬" },
  { href: "/agents", label: "Agentes IA", icon: "🤖" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return null;

  return (
    <div className="flex h-screen">
      <nav className="flex w-52 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <h1 className="font-semibold">Conversia</h1>
          <p className="text-xs text-slate-400">Panel de atención</p>
        </div>
        <div className="flex-1 space-y-1 p-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm ${
                pathname.startsWith(item.href)
                  ? "bg-cyan-50 font-medium text-cyan-800"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span className="mr-2">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
        <button
          onClick={() => {
            clearToken();
            window.location.href = "/login";
          }}
          className="border-t border-slate-200 p-3 text-left text-xs text-slate-400 hover:text-slate-600"
        >
          Cerrar sesión
        </button>
      </nav>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
