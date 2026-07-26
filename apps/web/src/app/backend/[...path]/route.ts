import type { NextRequest } from "next/server";

// Proxy same-origin hacia la API. Route handler = se ejecuta SIEMPRE en
// runtime (a diferencia de rewrites, que se congelan en el build), por lo
// que API_URL puede venir del entorno del contenedor en producción.
export const dynamic = "force-dynamic";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const apiBase = process.env.API_URL ?? "http://localhost:4000";
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${apiBase}/${path.join("/")}${search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");

  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    redirect: "manual",
  });

  const outHeaders = new Headers(res.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  outHeaders.delete("transfer-encoding");
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
