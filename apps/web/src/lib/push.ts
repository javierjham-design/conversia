// Adaptador Web Push del cliente. TODA llamada al API de push del navegador vive
// aquí — el resto de la app no toca navigator.serviceWorker ni PushManager.
import { api } from "./api";

export type PushSupport =
  | { supported: true; reason?: undefined }
  | { supported: false; reason: "unsupported" | "ios-needs-install" };

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as any).standalone === true
  );
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS se presenta como Mac con touch
    (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
}

/** ¿Puede este dispositivo recibir Web Push ahora mismo? */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    // iOS < 16.4 o navegador sin push. En iOS, si además no está instalada, guía a instalar.
    if (isIOS() && !isStandalone()) return { supported: false, reason: "ios-needs-install" };
    return { supported: false, reason: "unsupported" };
  }
  // iOS 16.4+ exige la PWA instalada en pantalla de inicio.
  if (isIOS() && !isStandalone()) return { supported: false, reason: "ios-needs-install" };
  return { supported: true };
}

export function permissionState(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Registra el service worker (idempotente). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Pide permiso (debe llamarse tras una acción del usuario), se suscribe y registra
 * el dispositivo en el backend. Devuelve el estado resultante.
 */
export type EnablePushResult = { status: "granted" | "denied" | "unsupported" | "error"; detail?: string };

export async function enablePush(): Promise<EnablePushResult> {
  const support = pushSupport();
  if (!support.supported) return { status: "unsupported" };
  const reg = await registerServiceWorker();
  if (!reg) return { status: "error", detail: "no se pudo registrar el service worker" };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { status: permission === "denied" ? "denied" : "error" };

    const { publicKey } = await api<{ publicKey: string | null }>("/notifications/vapid-public-key");
    if (!publicKey) return { status: "unsupported", detail: "el servidor no tiene VAPID configurado" };
    const appKey = urlBase64ToUint8Array(publicKey);

    // Si ya hay una suscripción con OTRA applicationServerKey (VAPID rotado), Chrome rechaza
    // re-suscribir con la nueva → la damos de baja y creamos una limpia.
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = new Uint8Array((sub.options?.applicationServerKey as ArrayBuffer | null) ?? new ArrayBuffer(0));
      const same = cur.length === appKey.length && cur.every((b, i) => b === appKey[i]);
      if (!same) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey as unknown as BufferSource,
      });
    }

    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { status: "error", detail: "el navegador no entregó las claves de la suscripción" };
    }
    await api("/notifications/devices", {
      method: "POST",
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        platform: isStandalone() ? "desktop" : "web",
        label: navigator.userAgent.slice(0, 80),
      }),
    });
    return { status: "granted" };
  } catch (e) {
    return { status: "error", detail: ((e as Error)?.message ?? String(e)).slice(0, 200) };
  }
}

/** Baja del dispositivo actual (logout / desactivar). */
export async function disablePush(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api(`/notifications/devices?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

/** Informa al backend qué conversación se está mirando (dedup de push). */
export async function reportViewing(conversationId: string | null): Promise<void> {
  await api("/notifications/viewing", { method: "POST", body: JSON.stringify({ conversationId }) }).catch(() => {});
}
