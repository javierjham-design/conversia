/**
 * Conversia web (F3). App Next.js propia, design system aparte de apps/web. Habla con
 * la MISMA API (NEXT_PUBLIC_API_URL). Cabeceras de seguridad propias. Usa el SDK de
 * Meta (Embedded Signup de WhatsApp en /canales) y el de Google Identity Services
 * (botón "Continuar con Google" en /login).
 * @type {import('next').NextConfig}
 */
const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
// Red de seguridad (hallazgo prod 17-oct-2026): si el build salió sin la variable, el
// runtime cae a la API pública (lib/api-base.ts) — la CSP debe permitirla SIEMPRE.
const prodApiFallback = "https://api-production-cf8e.up.railway.app";
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https://graph.facebook.com https://*.fbcdn.net https://*.cdninstagram.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // 'unsafe-eval' SOLO en dev: el runtime de react-refresh de Next lo exige y sin él
  // la página queda sin hidratar (botones muertos). En producción NO se emite.
  // cloudflareinsights: beacon que inyecta Cloudflare en el dominio (evita el error de consola).
  // connect.facebook.net: SDK del Embedded Signup de WhatsApp — sin él, /canales no
  // puede abrir la ventana de Meta y la UI lo confundía con "popup bloqueado"
  // (hallazgo prod 18-oct-2026, con pantallazo de Javier; espeja la CSP de apps/web).
  // accounts.google.com: Google Identity Services (gsi/client) para el botón de login.
  `script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://connect.facebook.net https://accounts.google.com${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  // frame-src: iframes internos del SDK de Facebook (login/status) y de Google (botón GIS).
  // frame-ancestors sigue en 'none': nadie puede embeber NUESTRO panel.
  "frame-src 'self' https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com https://accounts.google.com",
  `connect-src 'self' ${api} ${prodApiFallback} https://cloudflareinsights.com https://graph.facebook.com https://www.facebook.com https://accounts.google.com`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

const nextConfig = {
  // La regla no-restricted-imports (no importar apps/web) vive en .eslintrc.json y se
  // valida con el linter; no bloqueamos el build de Next por ESLint (no instalado aquí).
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // HTML con TTL CORTO en el CDN (hallazgo prod 17-oct-2026): las páginas estáticas
      // salían con s-maxage=31536000 y Cloudflare servía versiones VIEJAS por meses tras
      // cada deploy. Los assets /_next/static quedan fuera (van versionados por hash y
      // pueden cachearse un año). Complemento operativo: regla de caché en Cloudflare
      // que haga bypass del HTML (ver RUNBOOK_GOLIVE_V2.md).
      {
        source: "/((?!_next/static|_next/image|favicon|.*\\.(?:png|jpg|svg|ico|woff2?)).*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, s-maxage=60, stale-while-revalidate=300" }],
      },
    ];
  },
  // El alta de autoservicio (D7) y el bot comercial usan /registro (ES). Mantener /register
  // como alias por compatibilidad.
  async redirects() {
    return [{ source: "/register", destination: "/registro", permanent: true }];
  },
};

export default nextConfig;
