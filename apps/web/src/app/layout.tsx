import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
