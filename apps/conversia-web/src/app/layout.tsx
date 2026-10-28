import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { PROD_API_FALLBACK } from "@/lib/api-base";

// M3 — origen de la API (cross-origin) para preconectar y acelerar el primer fetch.
const API_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || PROD_API_FALLBACK).origin;
  } catch {
    return "";
  }
})();

/*
 * A10 — tipografía del design system "Nocturna", servida desde el propio dominio (la CSP
 * del panel solo admite `font-src 'self'`).
 *
 * Los archivos viven en el repo (`./fonts`) en vez de pedírselos a Google en cada build:
 * `next/font/google` descarga y parsea el CSS de Google DURANTE el build, y cuando esa
 * respuesta no viene como el loader espera revienta con un `TypeError: Cannot read
 * properties of null (reading '1')` que no tiene nada que ver con el código. Era el flake
 * que obligaba a re-lanzar el job `build` cada varios PRs —incluido el de este cambio— y
 * convierte un verde en una moneda al aire. Ahora el build no sale a internet.
 *
 * Son las MISMAS fuentes: los woff2 variables del subconjunto latino que servía Google
 * (Inter v20, Fraunces v38). Para reemplazarlas: pedir el CSS de Google con un
 * `User-Agent` de Chrome, tomar la URL del bloque cuyo `unicode-range` incluye
 * U+0000-00FF y guardarla acá.
 *
 * M3 — display:"optional" en los titulares (Fraunces es el elemento LCP): con el fallback
 * ajustado por métricas el titular pinta YA, sin el swap tardío que disparaba el LCP a
 * ~3,4 s bajo 4G. Inter (cuerpo) queda en "swap". `adjustFontFallback` va explícito porque
 * con fuentes locales no se puede deducir de la familia: Fraunces es serif, Inter no.
 */
const fraunces = localFont({
  src: [
    { path: "./fonts/fraunces-latin-variable.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/fraunces-latin-variable-italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-fraunces",
  display: "optional",
  adjustFontFallback: "Times New Roman",
});
const inter = localFont({
  src: [{ path: "./fonts/inter-latin-variable.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Conversia",
  description: "Tu negocio, atendido. Conversia — atención por WhatsApp con IA.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Conversia", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// M3 — viewport-fit=cover es imprescindible para que env(safe-area-inset-*) tenga valor en
// iOS (si no, la tab bar queda bajo el home indicator). maximumScale alto = no bloquea zoom (a11y).
export const viewport: Viewport = { themeColor: "#0f2027", viewportFit: "cover", width: "device-width", initialScale: 1, maximumScale: 5 };

// A9 — registro del service worker (PWA instalable). Se ejecuta tras cargar; sin skipWaiting.
const swRegister = `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`;

// Aplica modo (claro/oscuro) y acento ANTES del paint para evitar flash. Default:
// "Nocturna" (oscuro) + acento menta; el valor real lo fija la preferencia del usuario.
const bootstrap = `(function(){try{var t=localStorage.getItem('conversia_theme')||'dark';var a=localStorage.getItem('conversia_accent')||'menta';var r=document.documentElement;r.setAttribute('data-theme',t);r.setAttribute('data-accent',a);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" data-theme="dark" data-accent="menta" className={`${fraunces.variable} ${inter.variable}`}>
      <head>
        {API_ORIGIN ? (
          <>
            <link rel="preconnect" href={API_ORIGIN} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={API_ORIGIN} />
          </>
        ) : null}
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: swRegister }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
