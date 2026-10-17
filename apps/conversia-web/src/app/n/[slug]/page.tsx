import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PROD_API_FALLBACK } from "@/lib/api-base";

/* PELDAÑO 3 — mini-sitio público del negocio (conversia.cl/n/<slug>): para el cliente SIN
 * página web. Página pública (sin auth, sin AppShell), renderizada en el servidor con SEO
 * básico. Lee SOLO datos públicos de GET /public/n/:slug (nada del CRM). Cacheable. */

export const revalidate = 300; // ISR: refresca cada 5 min

type MiniSite = {
  slug: string;
  name: string;
  rubro: string | null;
  tagline: string | null;
  about: string | null;
  whatsapp: { number: string | null; link: string } | null;
  services: { name: string; price: number | null; currency: string; description: string | null }[];
  hours: string | null;
  contact: { address: string | null; instagram: string | null; email: string | null; phone: string | null };
  accent: string | null;
};

// Base de la API segura en servidor (misma regla que api-base: ignora localhost roto).
function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(env)) return env;
  return env ?? PROD_API_FALLBACK;
}

async function fetchSite(slug: string): Promise<MiniSite | null> {
  try {
    const res = await fetch(`${apiBase()}/public/n/${encodeURIComponent(slug)}`, { next: { revalidate } });
    if (!res.ok) return null;
    return (await res.json()) as MiniSite;
  } catch {
    return null;
  }
}

function money(price: number | null, currency: string): string | null {
  if (price == null) return null;
  try {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency, maximumFractionDigits: currency === "CLP" ? 0 : 2 }).format(price);
  } catch {
    return `${price}`;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const site = await fetchSite(slug);
  if (!site) return { title: "Página no encontrada" };
  const title = `${site.name}${site.rubro ? ` · ${site.rubro}` : ""}`;
  const description = site.tagline ?? site.about ?? `${site.name} — escríbenos por WhatsApp.`;
  return {
    title,
    description,
    robots: { index: true, follow: true },
    openGraph: { title, description, type: "website", siteName: site.name },
    twitter: { card: "summary", title, description },
  };
}

export default async function MiniSitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await fetchSite(slug);
  if (!site) notFound();

  const hasServices = site.services.length > 0;

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--ink)", display: "flex", flexDirection: "column", alignItems: "center", padding: "0 16px" }}>
      <div style={{ width: "100%", maxWidth: 560, padding: "48px 0 32px" }}>
        {/* Hero */}
        <header style={{ textAlign: "center", marginBottom: 28 }}>
          {site.rubro ? (
            <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--acc-deep)" }}>{site.rubro}</span>
          ) : null}
          <h1 className="display" style={{ fontSize: 34, lineHeight: 1.1, margin: "8px 0 0" }}>{site.name}</h1>
          {site.tagline ? <p className="text-dim" style={{ fontSize: 16, margin: "12px 0 0", lineHeight: 1.5 }}>{site.tagline}</p> : null}
        </header>

        {/* CTA WhatsApp (acción principal) */}
        {site.whatsapp ? (
          <a
            href={site.whatsapp.link}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", padding: "15px 20px", borderRadius: 14, background: "#25D366", color: "#07321b", fontWeight: 700, fontSize: 16.5, textDecoration: "none", boxShadow: "0 8px 24px rgba(37,211,102,0.25)" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 018.413 3.488 11.82 11.82 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 001.515 5.26l-.999 3.648 3.973-1.607zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.074-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
            Escríbenos por WhatsApp
          </a>
        ) : null}

        {/* Acerca de */}
        {site.about ? (
          <section className="card" style={{ padding: 18, marginTop: 20 }}>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{site.about}</p>
          </section>
        ) : null}

        {/* Servicios con precios */}
        {hasServices ? (
          <section style={{ marginTop: 20 }}>
            <h2 className="display" style={{ fontSize: 20, margin: "0 0 12px" }}>Servicios</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {site.services.map((s, i) => {
                const price = money(s.price, s.currency);
                return (
                  <div key={i} className="card" style={{ padding: "13px 15px", display: "flex", alignItems: "baseline", gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: 14.5 }}>{s.name}</p>
                      {s.description ? <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12.5, lineHeight: 1.45 }}>{s.description}</p> : null}
                    </div>
                    {price ? <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--acc-deep)", whiteSpace: "nowrap" }}>{price}</span> : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Horarios + contacto */}
        {site.hours || site.contact.address || site.contact.instagram ? (
          <section className="card" style={{ padding: 18, marginTop: 20, display: "flex", flexDirection: "column", gap: 11 }}>
            {site.hours ? (
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13.5 }}>Horarios</p>
                <p className="text-dim" style={{ margin: "3px 0 0", fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{site.hours}</p>
              </div>
            ) : null}
            {site.contact.address ? (
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13.5 }}>Dónde estamos</p>
                <p className="text-dim" style={{ margin: "3px 0 0", fontSize: 13.5, lineHeight: 1.5 }}>{site.contact.address}</p>
              </div>
            ) : null}
            {site.contact.instagram ? (
              <div>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 13.5 }}>Instagram</p>
                <a href={instagramUrl(site.contact.instagram)} target="_blank" rel="noopener noreferrer" style={{ margin: "3px 0 0", fontSize: 13.5, color: "var(--acc-deep)", display: "inline-block", textDecoration: "none" }}>
                  {site.contact.instagram.startsWith("@") ? site.contact.instagram : `@${site.contact.instagram}`}
                </a>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Segundo CTA */}
        {site.whatsapp ? (
          <div style={{ textAlign: "center", marginTop: 24 }}>
            <a href={site.whatsapp.link} target="_blank" rel="noopener noreferrer" className="btn-accent" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "11px 22px", borderRadius: 12, textDecoration: "none", fontWeight: 600, fontSize: 15 }}>
              Hablar por WhatsApp
            </a>
          </div>
        ) : null}

        {/* Pie */}
        <footer style={{ textAlign: "center", marginTop: 40 }}>
          <a href="https://conversia.cl" target="_blank" rel="noopener noreferrer" className="text-dim" style={{ fontSize: 12, textDecoration: "none" }}>
            Hecho con <strong style={{ color: "var(--acc-deep)" }}>Conversia</strong>
          </a>
        </footer>
      </div>
    </main>
  );
}

function instagramUrl(handle: string): string {
  const h = handle.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/$/, "");
  return `https://instagram.com/${h}`;
}
