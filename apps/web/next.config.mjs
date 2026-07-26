/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Proxy same-origin hacia la API: la URL se resuelve en RUNTIME (next start
  // relee next.config), no en build — evita depender de build-args y de CORS.
  async rewrites() {
    const api = process.env.API_URL ?? "http://localhost:4000";
    return [{ source: "/backend/:path*", destination: `${api}/:path*` }];
  },
};

export default nextConfig;
