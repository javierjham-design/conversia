/**
 * Cabeceras de seguridad del panel (ASVS 14.4 / OWASP Secure Headers).
 * CSP moderada compatible con Next 15 (app router usa estilos/inline propios).
 * Endurecer script-src con nonces es tarea de SECURITY_ROADMAP.
 * @type {import('next').NextConfig}
 */
// Orígenes de terceros permitidos SOLO para los SDK de autenticación:
//  - Facebook (WhatsApp Embedded Signup): connect.facebook.net + popup www.facebook.com
//  - Google (Sign-In / GIS): accounts.google.com + apis.google.com
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https://*.gstatic.com https://*.googleusercontent.com",
  "font-src 'self' data:",
  // Next inyecta estilos/inline bootstrap; se permite inline sólo aquí
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://accounts.google.com https://apis.google.com",
  // Iframes de los SDK (botón de Google, diálogos de Meta)
  "frame-src 'self' https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com https://accounts.google.com https://content.googleapis.com",
  // El panel habla con la API por su proxy same-origin (/backend/*) + los SDK de auth
  "connect-src 'self' https://graph.facebook.com https://www.facebook.com https://accounts.google.com",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  // allow-popups: necesario para los popups de OAuth (FB.login / Google Sign-In)
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // no revelar "X-Powered-By: Next.js"
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
