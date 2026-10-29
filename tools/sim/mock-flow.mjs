#!/usr/bin/env node
/**
 * FLOW DE JUGUETE para el stack de simulación. CERO llamadas a Flow de verdad.
 *
 * Existe para poder probar de punta a punta el peor modo de falla del cobro de recargas: el
 * **webhook perdido**. Flow cobra la tarjeta, llama a nuestra `urlConfirmation` y ese POST no
 * llega (un deploy en curso, un 500 nuestro en todos los reintentos, la red). El cargo queda
 * hecho y el cliente sin créditos. Con un Flow real eso no se puede ensayar; con este sí,
 * porque **a propósito NO llama nunca a `urlConfirmation`**: el cobro entra, el pago queda
 * pagado, y quien tiene que notarlo es la reconciliación del worker.
 *
 * ES SIN ESTADO. El token lleva dentro el pago:
 *
 *     simtok.<base64url({ commerceOrder, amount, optional, status })>
 *
 * así que la prueba decide qué va a contestar `payment/getStatus` eligiendo el token, sin
 * tener que sembrarle nada por otra puerta. `status` por defecto es 2 (pagado); poniendo 3 se
 * ensaya un rechazo que aparece recién en la reconciliación.
 *
 * NO VERIFICA LA FIRMA. Es deliberado y no se puede usar en ningún otro lugar: valida que
 * venga una `apiKey` y nada más. Lo que esta pieza prueba es el comportamiento NUESTRO ante
 * las respuestas de la pasarela; la firma la cubren los tests del adaptador.
 *
 *   node tools/sim/mock-flow.mjs           # escucha en 4021
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_FLOW_PORT || 4021);
const PREFIJO = "simtok.";

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const deB64url = (s) => Buffer.from(s, "base64url").toString("utf8");

/** Arma el token de un pago (lo usa la prueba para fabricar el cobro que se perdió). */
export const tokenDePago = (pago) => PREFIJO + b64url(JSON.stringify(pago));

function pagoDeToken(token) {
  if (typeof token !== "string" || !token.startsWith(PREFIJO)) return null;
  try {
    return JSON.parse(deB64url(token.slice(PREFIJO.length)));
  } catch {
    return null;
  }
}

function responder(res, code, body) {
  const txt = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(txt) });
  res.end(txt);
}

const server = createServer((req, res) => {
  const trozos = [];
  req.on("data", (c) => trozos.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://mock-flow");
    const ruta = url.pathname.replace(/^\/api\/?/, "");
    const cuerpo = Object.fromEntries(new URLSearchParams(Buffer.concat(trozos).toString("utf8")));
    const p = { ...Object.fromEntries(url.searchParams), ...cuerpo };
    if (!p.apiKey) return responder(res, 401, { code: 401, message: "apiKey requerida" });

    if (ruta === "customer/create") {
      return responder(res, 200, { customerId: `simcus_${p.externalId ?? Date.now()}` });
    }
    if (ruta === "customer/register") {
      const token = tokenDePago({ registro: p.customerId });
      return responder(res, 200, { url: "http://mock-flow/pagar", token });
    }
    if (ruta === "customer/getRegisterStatus") {
      return responder(res, 200, { status: 1, creditCardType: "Visa", last4digits: "4242" });
    }
    if (ruta === "customer/collect") {
      // El cobro ENTRA y queda pagado… y acá NO se llama a `p.urlConfirmation`. Ese silencio
      // es el escenario completo: la tarjeta cobrada y nadie avisándonos.
      const token = tokenDePago({ commerceOrder: p.commerceOrder, amount: Number(p.amount ?? 0), optional: p.optional, status: 2 });
      console.log(`• collect ${p.commerceOrder} $${p.amount} → ${token.slice(0, 24)}… (webhook NO enviado, a propósito)`);
      return responder(res, 200, { token, flowOrder: 1 });
    }
    if (ruta === "payment/getStatus") {
      const pago = pagoDeToken(p.token);
      if (!pago) return responder(res, 200, { code: 1, message: "token desconocido", status: 1 });
      return responder(res, 200, {
        status: pago.status ?? 2,
        commerceOrder: pago.commerceOrder ?? "",
        amount: pago.amount ?? 0,
        optional: pago.optional ?? null,
      });
    }
    return responder(res, 404, { code: 404, message: `mock-flow: ${ruta} no implementado` });
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Flow de juguete escuchando en :${PORT} (NUNCA en producción)`));
