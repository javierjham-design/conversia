"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, MailWarning, MoreHorizontal, Sparkles, X } from "lucide-react";
import { api, getToken, getRefreshToken, getSessionDeadline, plazoVencido, sessionActive, clearToken, logout } from "@/lib/api";
import { SupportWidget } from "@/components/SupportWidget";
import { PwaManager } from "@/components/PwaManager";
import { openAssistant } from "@/lib/assistant";
import { GRUPOS, PRIMARIOS, RESTO, esActiva } from "@/lib/nav";

/**
 * NAVEGACIÓN UNIFICADA de Conversia (misma en TODAS las pantallas):
 * - Escritorio/tablet (≥768px): riel fijo a la izquierda con **icono + nombre**, agrupado.
 * - Móvil (<768px): barra de pestañas inferior (los 4 del día a día + "Más").
 * El breakpoint se resuelve con CSS (clases .shell-rail / .shell-tabs en globals.css),
 * no con JS — un solo layout, dos presentaciones.
 *
 * El riel era de SOLO ICONOS con tooltip. Con nueve destinos eso es un acertijo: el dueño
 * reportó que no sabía a qué sección estaba entrando. Y cuatro secciones (`/caja`,
 * `/clientes`, `/mini-sitio`, `/ajustes`) no se enlazan desde ninguna otra pantalla, así que
 * un riel que no se entiende las esconde. Los nombres y los grupos salen de `lib/nav.ts`, la
 * misma tabla de la que sale el título de cada pantalla.
 */

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

  const [moreOpen, setMoreOpen] = useState(false);

  // Guard de sesión (toda pantalla con shell es privada):
  //  - Sin token NI refresh → al login.
  //  - Pasado el PLAZO MÁXIMO de la sesión (24 h) → al login con aviso, sin intentar nada: el
  //    servidor ya no la renueva, así que dejar pasar solo mostraría un panel que no carga.
  //  - Access vencido y SIN refresh con que renovar → al login con aviso de "sesión expiró"
  //    (sin flash de panel muerto). Si hay refresh, dejamos pasar: la 1.ª llamada a la API lo
  //    renueva sola (lib/api) y el usuario ni se entera.
  useEffect(() => {
    const t = getToken();
    const rt = getRefreshToken();
    if (!t && !rt) {
      router.replace("/login");
    } else if (plazoVencido(getSessionDeadline()) || (t && !sessionActive(t) && !rt)) {
      clearToken();
      router.replace(`/login?expirada=1&volver=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
  }, [router]);

  async function cerrarSesion() {
    await logout();
    router.replace("/login");
  }

  // Hidrata el ACENTO del usuario desde el servidor en TODA pantalla (no solo Ajustes) para
  // que la personalización de color persista cross-dispositivo (CONVERSIA_DISENO.md §3).
  useEffect(() => {
    if (!getToken()) return;
    api<{ user?: { settings?: { accent?: string } | null } }>("/auth/me")
      .then((me) => {
        const a = me.user?.settings?.accent;
        if (a && typeof a === "string") {
          document.documentElement.setAttribute("data-accent", a);
          try { localStorage.setItem("conversia_accent", a); } catch { /* ignore */ }
        }
      })
      .catch(() => {});
  }, []);

  // Cierra la hoja "Más" al navegar.
  useEffect(() => { setMoreOpen(false); }, [pathname]);

  const moreActive = RESTO.some((g) => g.items.some((n) => esActiva(pathname, n.href)));

  return (
    <div className="shell">
      <nav className="shell-rail" aria-label="Navegación">
        {/* El logo vuelve al inicio: es donde todo el mundo hace clic para volver. */}
        <a href="/inicio" className="shell-brand display" aria-label="Conversia — ir al inicio">C</a>

        {GRUPOS.map((grupo) => (
          <div key={grupo.titulo} className="nav-grupo">
            <p className="nav-grupo-titulo">{grupo.titulo}</p>
            <ul>
              {grupo.items.map(({ href, label, Icon }) => {
                const activa = esActiva(pathname, href);
                return (
                  <li key={href}>
                    <a
                      href={href}
                      className={activa ? "nav-link activa" : "nav-link"}
                      title={label}
                      aria-current={activa ? "page" : undefined}
                    >
                      <Icon size={20} strokeWidth={2} />
                      <span className="nav-label">{label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* Cerrar sesión: al final del riel, separado de la navegación. */}
        <button
          onClick={cerrarSesion}
          className="nav-link nav-salir"
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
        >
          <LogOut size={20} strokeWidth={2} />
          <span className="nav-label">Cerrar sesión</span>
        </button>
      </nav>

      <div className="shell-body">
        <VerifyBanner />
        {children}
      </div>

      <SupportWidget />
      <PwaManager />


      {/* M9 — hoja "Más" (overflow) para móvil */}
      {moreOpen ? (
        <>
          <div onClick={() => setMoreOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 40 }} />
          {/* `hoja-mas` es el asidero para las pruebas: en teléfono el riel sigue en el DOM
              (oculto por CSS), así que buscar "Tu negocio" a secas encuentra DOS. */}
          {/* Fondo SÓLIDO: la clase `card` es vidrio esmerilado (4% de blanco) y con la hoja
              más alta el contenido de atrás se leía a través de los nombres del menú. */}
          <div className="card hoja-mas" style={{ position: "fixed", left: 12, right: 12, bottom: 76, zIndex: 41, padding: 10, borderRadius: 16, background: "var(--surface-solid)", boxShadow: "0 18px 50px rgba(0,0,0,.45)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 8px" }}>
              <span className="text-dim" style={{ fontSize: 12, fontWeight: 600 }}>Más</span>
              <button onClick={() => setMoreOpen(false)} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }}><X size={18} /></button>
            </div>
            {/* Los mismos grupos que el riel: con el título a la vista, "Caja" (el dinero del
                negocio) no se confunde con "Cobros" (lo que Conversia te cobra). */}
            {RESTO.map((grupo) => (
              <div key={grupo.titulo} style={{ marginBottom: 8 }}>
                <p className="text-dim" style={{ margin: "0 0 4px", padding: "0 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.6 }}>{grupo.titulo}</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
                  {grupo.items.map(({ href, label, Icon }) => {
                    const activa = esActiva(pathname, href);
                    return (
                      <a key={href} href={href} className={activa ? "nav-link activa" : "nav-link"} aria-current={activa ? "page" : undefined} style={{ width: "100%", height: 46, justifyContent: "flex-start", gap: 10, padding: "0 12px", fontSize: 14 }}>
                        <Icon size={20} strokeWidth={2} />
                        <span className="nav-label">{label}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}>
              {/* Asistente Conversia (B): abre la burbuja con el contexto actual. */}
              <button
                onClick={() => { setMoreOpen(false); openAssistant({ topic: "menu" }); }}
                className="nav-link"
                style={{ width: "100%", height: 46, justifyContent: "flex-start", gap: 10, padding: "0 12px", fontSize: 14, border: "none", background: "transparent", cursor: "pointer" }}
              >
                <Sparkles size={20} strokeWidth={2} />
                <span>Asistente</span>
              </button>
              {/* Cerrar sesión (ocupa la fila completa, separado del resto). */}
              <button
                onClick={() => { setMoreOpen(false); void cerrarSesion(); }}
                className="nav-link"
                aria-label="Cerrar sesión"
                style={{ gridColumn: "1 / -1", width: "100%", height: 46, justifyContent: "flex-start", gap: 10, padding: "0 12px", fontSize: 14, border: "none", borderTop: "1px solid var(--hairline)", borderRadius: 0, marginTop: 4, background: "transparent", color: "var(--danger)", cursor: "pointer" }}
              >
                <LogOut size={20} strokeWidth={2} />
                <span>Cerrar sesión</span>
              </button>
            </div>
          </div>
        </>
      ) : null}

      <nav className="shell-tabs" aria-label="Navegación">
        {PRIMARIOS.map(({ href, label, Icon }) => {
          const activa = esActiva(pathname, href);
          return (
            <a key={href} href={href} className={activa ? "tab-item active" : "tab-item"} aria-current={activa ? "page" : undefined}>
              <Icon size={22} strokeWidth={2} />
              <span>{label}</span>
            </a>
          );
        })}
        <button type="button" onClick={() => setMoreOpen((v) => !v)} className={moreActive || moreOpen ? "tab-item active" : "tab-item"} aria-label="Más" style={{ border: "none", background: "transparent", cursor: "pointer" }}>
          <MoreHorizontal size={22} strokeWidth={2} />
          <span>Más</span>
        </button>
      </nav>
    </div>
  );
}
