#!/usr/bin/env bash
# Levanta el stack de simulación COMPLETO (postgres + redis + migración/seed + api + worker
# + conversia-web) con un comando y espera a que api y web respondan (smoke gate).
# Uso:  bash tools/sim/up.sh            (en Windows: Git Bash)
#       DOWN=1 bash tools/sim/up.sh     para bajarlo (DOWN=v borra el volumen)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="docker compose -f tools/sim/docker-compose.sim.yml"
cd "$ROOT"

if [ "${DOWN:-}" = "1" ]; then $COMPOSE down; exit 0; fi
if [ "${DOWN:-}" = "v" ]; then $COMPOSE down -v; exit 0; fi

echo "▶ Construyendo y levantando el stack (la primera vez tarda: 3 imágenes del monorepo)…"
$COMPOSE up -d --build

echo "▶ Esperando la migración/seed (db-init)…"
# db-init es one-shot; api espera a que termine OK vía depends_on.

wait_for() { # url, nombre, intentos
  local url="$1" name="$2" tries="${3:-60}"
  for i in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "  ✓ $name OK"; return 0; fi
    sleep 3
  done
  echo "  ✗ $name NO respondió ($url). Logs: $COMPOSE logs --tail=50"; return 1
}

wait_for "http://localhost:4000/health" "api (:4000/health)" 80
wait_for "http://localhost:3002/login" "conversia-web (:3002)" 60

echo ""
echo "✅ Stack arriba:"
echo "   • API            http://localhost:4000  (health: /health)"
echo "   • conversia-web  http://localhost:3002"
echo "   • Postgres       localhost:5433 (db conversia_sim)   • Redis localhost:6379"
echo "   Proveedores en MOCK. Tenants demo sembrados. Para la carga: node tools/sim/sim250.mjs w1"
echo "   Bajar: DOWN=1 bash tools/sim/up.sh   (DOWN=v borra el volumen)"
