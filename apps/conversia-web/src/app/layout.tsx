import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Conversia",
  description: "Tu negocio, atendido. Conversia — atención por WhatsApp con IA.",
};

// Aplica modo (claro/oscuro) y acento ANTES del paint para evitar flash. Default:
// "Nocturna" (oscuro) + acento menta; el valor real lo fija la preferencia del usuario.
const bootstrap = `(function(){try{var t=localStorage.getItem('conversia_theme')||'dark';var a=localStorage.getItem('conversia_accent')||'menta';var r=document.documentElement;r.setAttribute('data-theme',t);r.setAttribute('data-accent',a);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" data-theme="dark" data-accent="menta">
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
