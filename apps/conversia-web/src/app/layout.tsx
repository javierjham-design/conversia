import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Fraunces, Inter } from "next/font/google";
import { PROD_API_FALLBACK } from "@/lib/api-base";

// M3 — origen de la API (cross-origin) para preconectar y acelerar el primer fetch.
const API_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || PROD_API_FALLBACK).origin;
  } catch {
    return "";
  }
})();

// A10 — tipografía del design system "Nocturna" realmente cargada. next/font auto-hospeda
// las fuentes en build (se sirven desde el propio dominio → compatible con la CSP font-src 'self').
// M3 — display:"optional" en la tipografía de titulares (Fraunces, que es el elemento LCP):
// con el fallback metric-matched de next/font el titular pinta YA, sin el swap tardío que
// disparaba el LCP a ~3,4 s bajo 4G. Inter (cuerpo) queda en "swap".
const fraunces = Fraunces({ subsets: ["latin"], weight: ["400", "600"], style: ["normal", "italic"], variable: "--font-fraunces", display: "optional" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

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
