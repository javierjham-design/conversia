/**
 * Conversia web (F3). App Next.js propia, design system aparte de apps/web. Habla con
 * la MISMA API (NEXT_PUBLIC_API_URL). Cabeceras de seguridad propias (sin los SDK de
 * Meta/Google del panel TuBot: Conversia aún no los usa).
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
  `script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  `connect-src 'self' ${api} ${prodApiFallback} https://cloudflareinsights.com`,
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
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // El alta de autoservicio (D7) y el bot comercial usan /registro (ES). Mantener /register
  // como alias por compatibilidad.
  async redirects() {
    return [{ source: "/register", destination: "/registro", permanent: true }];
  },
};

export default nextConfig;
