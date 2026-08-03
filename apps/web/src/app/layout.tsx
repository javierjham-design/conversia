import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TuBot — Panel",
  description: "Atención conversacional multi-tenant con agentes de IA",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
