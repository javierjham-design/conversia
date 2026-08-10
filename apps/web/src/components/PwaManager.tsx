"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { isIOS, isStandalone, registerServiceWorker } from "@/lib/push";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Gestiona el ciclo PWA en el cliente:
 *  - Registra el service worker y detecta ACTUALIZACIONES (avisa, no recarga solo,
 *    para no romper una conversación en curso ni borrar el compositor).
 *  - Banner de INSTALACIÓN en el momento oportuno (evento del navegador), y en iOS
 *    la guía "Compartir → Agregar a inicio". Descartable y sin volver a molestar.
 */
export function PwaManager() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const reg = await registerServiceWorker();
      if (!reg || !mounted) return;
      if (reg.waiting) setWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // "installed" + hay controller = es una ACTUALIZACIÓN (no la 1ª instalación).
          if (sw.state === "installed" && navigator.serviceWorker.controller) setWaiting(sw);
        });
      });
    })();

    // Al activarse la versión nueva, recarga una sola vez.
    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      if (localStorage.getItem("pwaInstallDismissed") !== "1") setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS no emite beforeinstallprompt: mostrar la guía si no está instalada.
    if (isIOS() && !isStandalone() && localStorage.getItem("pwaIosHintDismissed") !== "1") {
      setIosHint(true);
    }

    return () => {
      mounted = false;
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  function applyUpdate() {
    waiting?.postMessage("SKIP_WAITING");
    setWaiting(null);
  }

  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    await installEvt.userChoice.catch(() => undefined);
    setInstallEvt(null);
  }

  return (
    <>
      {waiting && (
        <div className="fixed bottom-4 left-4 z-[60] flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] shadow-2xl">
          <RefreshCw size={15} className="text-brand-600 dark:text-accent-400" />
          <span className="text-ink">Hay una versión nueva.</span>
          <button onClick={applyUpdate} className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700">
            Actualizar
          </button>
          <button onClick={() => setWaiting(null)} aria-label="Después" className="text-ink-subtle hover:text-ink">
            <X size={14} />
          </button>
        </div>
      )}

      {installEvt && (
        <div className="fixed bottom-4 left-1/2 z-[55] flex -translate-x-1/2 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] shadow-2xl">
          <Download size={15} className="text-brand-600 dark:text-accent-400" />
          <span className="text-ink">Instala TuBot en tu dispositivo</span>
          <button onClick={() => void install()} className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700">
            Instalar
          </button>
          <button
            onClick={() => {
              setInstallEvt(null);
              localStorage.setItem("pwaInstallDismissed", "1");
            }}
            aria-label="Ahora no"
            className="text-ink-subtle hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {iosHint && (
        <div className="fixed bottom-4 left-1/2 z-[55] flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px] shadow-2xl">
          <Download size={15} className="text-brand-600 dark:text-accent-400" />
          <span className="text-ink">Para instalar: <b>Compartir</b> → <b>Agregar a inicio</b></span>
          <button
            onClick={() => {
              setIosHint(false);
              localStorage.setItem("pwaIosHintDismissed", "1");
            }}
            aria-label="Entendido"
            className="text-ink-subtle hover:text-ink"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
