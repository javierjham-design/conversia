import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Legal — TuBot",
  robots: { index: true, follow: true },
};

const links = [
  { href: "/legal/privacidad", label: "Privacidad" },
  { href: "/legal/terminos", label: "Términos" },
  { href: "/legal/eliminacion-datos", label: "Eliminación de datos" },
];

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/">
            <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="h-7 w-auto" />
          </Link>
          <nav className="flex gap-4 text-sm text-slate-500">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="hover:text-brand-600">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        <article
          className="max-w-none text-sm leading-relaxed text-slate-700
            [&_h1]:mb-1 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-slate-900
            [&_h2]:mb-2 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900
            [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1
            [&_a]:text-brand-600 [&_a]:underline [&_strong]:text-slate-900"
        >
          {children}
        </article>
      </main>
      <footer className="mx-auto max-w-3xl px-6 pb-12 text-xs text-slate-400">
        © {new Date().getFullYear()} Servicios Digital-Dent SpA · TuBot.cl — Atención conversacional multi-tenant
      </footer>
    </div>
  );
}
