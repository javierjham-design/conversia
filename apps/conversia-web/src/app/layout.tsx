import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Fraunces, Inter } from "next/font/google";

// A10 — tipografía del design system "Nocturna" realmente cargada. next/font auto-hospeda
// las fuentes en build (se sirven desde el propio dominio → compatible con la CSP font-src 'self').
const fraunces = Fraunces({ subsets: ["latin"], weight: ["400", "600"], style: ["normal", "italic"], variable: "--font-fraunces", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Conversia",
  description: "Tu negocio, atendido. Conversia — atención por WhatsApp con IA.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Conversia", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#0f2027" };

// A9 — registro del service worker (PWA instalable). Se ejecuta tras cargar; sin skipWaiting.
const swRegister = `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`;

// Aplica modo (claro/oscuro) y acento ANTES del paint para evitar flash. Default:
// "Nocturna" (oscuro) + acento menta; el valor real lo fija la preferencia del usuario.
const bootstrap = `(function(){try{var t=localStorage.getItem('conversia_theme')||'dark';var a=localStorage.getItem('conversia_accent')||'menta';var r=document.documentElement;r.setAttribute('data-theme',t);r.setAttribute('data-accent',a);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" data-theme="dark" data-accent="menta" className={`${fraunces.variable} ${inter.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: swRegister }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
