import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { runWhatsappTokenHealth } from "./whatsapp-token-health.js";

/**
 * Corre el chequeo de salud de tokens UNA vez y sale. Para pruebas (Docker) y para forzar una
 * verificación manual sin esperar el intervalo de 15 min:
 *   docker exec conversia-sim-worker node apps/worker/dist/token-health-cli.js
 * Imprime el snapshot como JSON en stdout (prefijo SNAPSHOT:) y sale 0 si ok, 1 si hay caídas.
 */
async function main() {
  const connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  try {
    const snap = await runWhatsappTokenHealth(connection);
    console.log("SNAPSHOT:" + JSON.stringify(snap));
    process.exitCode = snap.ok ? 0 : 1;
  } finally {
    await connection.quit().catch(() => undefined);
  }
}

void main().catch((e) => {
  console.error("token-health-cli:", (e as Error).message);
  process.exit(2);
});
