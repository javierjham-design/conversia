"use client";
import { useEffect, useState } from "react";
import { Download, RefreshCw, Share, X } from "lucide-react";
import { api } from "@/lib/api";

/* M1 (PWA) — instalación guiada + aviso de versión nueva.
 *  - Android/escritorio: captura `beforeinstallprompt` y ofrece "Instalar".
 *  - iOS (16.4+): no hay prompt; muestra instrucciones (Compartir → Añadir a inicio).
 *  - Registra `pwa.installed` (auditoría) para medir adopción.
 *  - Detecta un SW nuevo en espera y ofrece "Recargar" (coherente con el SW: SKIP_WAITING). */

const DISMISS_KEY = "conversia_pwa_install_dismissed";

function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (window.navigator as any).standalone === true;
  } catch {
    return false;
  }
}

export function PwaManager() {
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [updateReg, setUpdateReg] = useState<ServiceWorkerRegistration | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      /* noop */
    }
    if (isStandalone()) return; // ya instalada: nada que ofrecer

    const onBip = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    const onInstalled = () => {
      setInstallEvt(null);
      setShowIosHint(false);
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* noop */
      }
      // Auditoría de adopción (best-effort, no rompe nada si falla).
      void api("/auth/pwa-installed", { method: "POST", body: JSON.stringify({ platform: navigator.platform || "web" }) }).catch(() => undefined);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);

    // iOS: sin beforeinstallprompt. Mostrar instrucciones si es iPhone/iPad en Safari.
    const ua = navigator.userAgent || "";
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    if (isIOS && isSafari) setShowIosHint(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Detección de versión nueva del service worker.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let active = true;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg || !active) return;
      if (reg.waiting && navigator.serviceWorker.controller) setUpdateReg(reg);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) setUpdateReg(reg);
        });
      });
    });
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  async function doInstall() {
    if (!installEvt) return;
    try {
      installEvt.prompt();
      await installEvt.userChoice;
    } catch {
      /* el usuario cerró el diálogo */
    }
    setInstallEvt(null);
  }

  function dismiss() {
    setInstallEvt(null);
    setShowIosHint(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* noop */
    }
  }

  function applyUpdate() {
    updateReg?.waiting?.postMessage("SKIP_WAITING");
    setUpdateReg(null);
  }

  const barBase: React.CSSProperties = {
    position: "fixed",
    left: 12,
    right: 12,
    bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
    zIndex: 60,
    maxWidth: 560,
    margin: "0 auto",
    borderRadius: 14,
    padding: "12px 14px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  };

  return (
    <>
      {/* Versión nueva disponible */}
      {updateReg ? (
        <div className="card" style={{ ...barBase, borderColor: "var(--acc)", background: "var(--card)" }}>
          <RefreshCw size={18} style={{ color: "var(--acc-deep)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13.5 }}>Hay una versión nueva de Conversia.</span>
          <button onClick={applyUpdate} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 13, padding: "7px 14px" }}>Recargar</button>
        </div>
      ) : null}

      {/* Instalación (Android/escritorio) */}
      {!dismissed && !updateReg && installEvt ? (
        <div className="card" style={{ ...barBase, background: "var(--card)" }}>
          <Download size={18} style={{ color: "var(--acc-deep)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13.5 }}>Instala Conversia en tu {isMobile() ? "teléfono" : "equipo"} para abrirla como app y recibir avisos.</span>
          <button onClick={doInstall} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 13, padding: "7px 14px", whiteSpace: "nowrap" }}>Instalar</button>
          <button onClick={dismiss} aria-label="Cerrar" className="card" style={{ cursor: "pointer", padding: 6, lineHeight: 0 }}><X size={15} /></button>
        </div>
      ) : null}

      {/* Instrucciones iOS */}
      {!dismissed && !updateReg && !installEvt && showIosHint ? (
        <div className="card" style={{ ...barBase, background: "var(--card)", alignItems: "flex-start" }}>
          <Share size={18} style={{ color: "var(--acc-deep)", flexShrink: 0, marginTop: 2 }} />
          <span style={{ flex: 1, fontSize: 13 }}>
            Instala Conversia: toca <strong>Compartir</strong> <Share size={12} style={{ verticalAlign: "middle" }} /> y luego <strong>“Añadir a pantalla de inicio”</strong>. Así recibes avisos aunque la cierres.
          </span>
          <button onClick={dismiss} aria-label="Cerrar" className="card" style={{ cursor: "pointer", padding: 6, lineHeight: 0 }}><X size={15} /></button>
        </div>
      ) : null}
    </>
  );
}

function isMobile(): boolean {
  try {
    return window.matchMedia("(max-width: 768px)").matches;
  } catch {
    return false;
  }
}
