import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conversia — Panel",
  description: "Atención conversacional multi-tenant con agentes de IA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
