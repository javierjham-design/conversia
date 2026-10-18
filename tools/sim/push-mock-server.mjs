#!/usr/bin/env node
// Servidor de PUSH SIMULADO para la carga de M6.3. Hace de "endpoint push" (como FCM/Mozilla):
// el worker le hace POST a /push/<id> con el payload cifrado + cabeceras VAPID. Aquí NO se
// descifra: solo se cuenta la entrega. ~10% de los ids responden 410 (suscripción muerta) para
// verificar que el worker las revoca. GET /stats devuelve los contadores.
//   node tools/sim/push-mock-server.mjs           (escucha en 0.0.0.0:8099)
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PUSH_MOCK_PORT || 8099);
const GONE_EVERY = Number(process.env.PUSH_MOCK_GONE_EVERY || 10); // 1 de cada 10 → 410 (~10%)
// web-push EXIGE TLS → si hay cert, servimos HTTPS (self-signed; el worker lo acepta con
// NODE_TLS_REJECT_UNAUTHORIZED=0, solo en el sim). Sin cert, HTTP (para pruebas sueltas).
const CERT = process.env.MOCK_CERT;
const KEY = process.env.MOCK_KEY;

let received = 0;
let gone = 0;
const seen = new Set();

const handler = (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ received, gone, uniqueEndpoints: seen.size }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/push/")) {
    const id = req.url.slice("/push/".length);
    // Drena el cuerpo (payload cifrado) sin procesarlo.
    req.on("data", () => {});
    req.on("end", () => {
      seen.add(id);
      const n = Number(id.replace(/\D/g, "")) || 0;
      // 410 Gone en ~10% → el worker debe marcar la suscripción revocada.
      if (n % GONE_EVERY === 0) {
        gone++;
        res.writeHead(410);
        res.end("gone");
      } else {
        received++;
        res.writeHead(201);
        res.end("ok");
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
};

const server = CERT && KEY ? createHttps({ key: readFileSync(KEY), cert: readFileSync(CERT) }, handler) : createHttp(handler);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`push-mock escuchando en :${PORT} (${CERT ? "HTTPS" : "HTTP"}, 410 en 1 de cada ${GONE_EVERY})`);
});
