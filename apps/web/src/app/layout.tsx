import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/*
 * Tipografía del sistema (B2): Inter para texto (excelente soporte de acentos y ñ, rápida)
 * y Sora para títulos (carácter geométrico).
 *
 * Los archivos viven en el repo en vez de pedírselos a Google en cada build.
 * `next/font/google` descarga y parsea el CSS de Google DURANTE el build, y cuando esa
 * respuesta no viene como el loader espera revienta con `TypeError: Cannot read properties
 * of null (reading '1')`, que no tiene nada que ver con el código. Acá tumbó el check
 * REQUERIDO `e2e-robustness` en un PR que solo tocaba documentos (29-oct-2026): un build
 * que sale a internet convierte cada merge en una moneda al aire. conversia-web ya lo
 * había resuelto así en #569; esto cierra el mismo agujero en TuBot.
 *
 * Son las MISMAS fuentes: los woff2 variables del subconjunto latino que servía Google
 * (Inter v20, Sora v17). Para reemplazarlas: pedir el CSS de Google con un `User-Agent` de
 * Chrome, tomar la URL del bloque cuyo `unicode-range` incluye U+0000-00FF y guardarla acá.
 *
 * `adjustFontFallback` va explícito porque con fuentes locales no se puede deducir de la
 * familia; las dos son sans, así que el fallback ajustado por métricas es Arial. El
 * `display:"swap"` se conserva tal cual estaba: esto cambia de dónde salen los archivos,
 * no cómo se ve ni cómo carga.
 */
const sans = localFont({
  src: [{ path: "./fonts/inter-latin-variable.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
  adjustFontFallback: "Arial",
});
const display = localFont({
  src: [{ path: "./fonts/sora-latin-variable.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "TuBot — Panel",
  description: "Atención conversacional multi-tenant con agentes de IA",
  manifest: "/manifest.webmanifest",
  applicationName: "TuBot",
  appleWebApp: { capable: true, title: "TuBot", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/brand/tubot-icon.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/tubot-icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/brand/tubot-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Respeta las safe areas de iPhone (notch / home indicator) en standalone.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
};

/** Aplica el tema guardado ANTES del primer paint (evita parpadeo claro→oscuro). */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('tubot-theme');var d=t==='dark'||((!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
