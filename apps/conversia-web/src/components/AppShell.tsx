"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarDays, CreditCard, Home, MailWarning, MessageCircle, Settings, Users } from "lucide-react";
import { api, getToken } from "@/lib/api";

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
  { href: "/ajustes", label: "Ajustes", Icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** Aviso de verificación de correo (D6): solo si el usuario aún no confirmó su correo. */
function VerifyBanner() {
  const [show, setShow] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ user?: { emailVerified?: boolean } }>("/auth/me")
      .then((me) => setShow(me.user?.emailVerified === false))
      .catch(() => {});
  }, []);

  if (!show) return null;

  async function resend() {
    setBusy(true);
    try {
      await api("/auth/resend-verification", { method: "POST" });
      setSent(true);
    } catch {
      /* noop */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", margin: "12px 16px 0", borderRadius: 12, background: "var(--acc-dim)", color: "var(--acc-deep)", fontSize: 13 }}>
      <MailWarning size={16} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        {sent ? "Te reenviamos el correo de verificación. Revisa tu bandeja." : "Confirma tu correo para asegurar tu cuenta. Te enviamos un enlace al registrarte."}
      </span>
      {!sent ? (
        <button onClick={resend} disabled={busy} style={{ border: "none", background: "var(--acc)", color: "var(--acc-ink)", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Enviando…" : "Reenviar"}
        </button>
      ) : null}
    </div>
  );
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

      <div className="shell-body">
        <VerifyBanner />
        {children}
      </div>

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
