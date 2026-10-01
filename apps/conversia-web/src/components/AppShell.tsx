"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, CreditCard, Home, MessageCircle, Users } from "lucide-react";
import { getToken } from "@/lib/api";

/**
 * NAVEGACIÓN UNIFICADA de Conversia (misma en TODAS las pantallas):
 * - Escritorio/tablet (≥620px): riel de iconos fijo a la izquierda.
 * - Móvil (<620px): barra de pestañas inferior.
 * El breakpoint se resuelve con CSS (clases .shell-rail / .shell-tabs en globals.css),
 * no con JS — un solo layout, dos presentaciones.
 */
const NAV = [
  { href: "/", label: "Hoy", Icon: Home },
  { href: "/conversaciones", label: "Conversaciones", Icon: MessageCircle },
  { href: "/agenda", label: "Agenda", Icon: CalendarDays },
  { href: "/clientes", label: "Clientes", Icon: Users },
  { href: "/cobros", label: "Cobros", Icon: CreditCard },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // Guard de sesión: sin token → al login (toda pantalla con shell es privada).
  useEffect(() => {
    if (!getToken()) router.replace("/login");
  }, [router]);

  return (
    <div className="shell">
      <nav className="shell-rail" aria-label="Navegación">
        <div className="shell-brand display">C</div>
        <ul>
          {NAV.map(({ href, label, Icon }) => (
            <li key={href}>
              <a href={href} className={isActive(pathname, href) ? "nav-item active" : "nav-item"} title={label} aria-label={label}>
                <Icon size={22} strokeWidth={2} />
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="shell-body">{children}</div>

      <nav className="shell-tabs" aria-label="Navegación">
        {NAV.map(({ href, label, Icon }) => (
          <a key={href} href={href} className={isActive(pathname, href) ? "tab-item active" : "tab-item"} aria-label={label}>
            <Icon size={22} strokeWidth={2} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
