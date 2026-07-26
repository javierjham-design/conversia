/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El proxy hacia la API vive en src/app/backend/[...path]/route.ts
  // (runtime real). No usar rewrites(): se congelan en el build.
};

export default nextConfig;
