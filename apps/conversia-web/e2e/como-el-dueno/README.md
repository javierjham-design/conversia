# Suite "COMO EL DUEÑO" (prueba real en Docker)

> **Ninguna funcionalidad se da por buena hasta que un navegador real, contra el stack
> Docker, recorre el flujo EXACTO del usuario y lo ve funcionar.** Lo que Javier hace a
> mano en la web, lo hace Playwright en Docker, siempre.

El navegador hace **exactamente** lo que haría el dueño (texto en pantalla, estados,
contadores, consola), **nunca** contra producción. Corre contra el stack `pnpm sim:up`
(api :4000, web :3002, postgres :5433) en móvil y escritorio, claro y oscuro (los 5
proyectos de `playwright.config.ts`).

## Regla permanente

**Cada bug que se reporte entra PRIMERO como test rojo de esta suite, luego se arregla
(verde). Sin excepciones.** Prohibido marcar verde algo que el navegador no haya visto
funcionar; prohibido bajar la vara: se arregla el producto.

## Jornadas (del documento `docs/PROMPT_PRUEBA_REAL_DOCKER.md`)

- **A — "Nazco y quedo operando"** (por cada rubro): registro desde el apex → panel 30/30
  → el asistente guía → cargo servicios por el chat → conecto canal (mock) → me escriben
  (webhook mock) → respondo desde la Bandeja → el crédito baja en /cobros.
- **B — "Me equivoco y el sistema me cuida"**: popup bloqueado → Reintentar / Pedir ayuda;
  pago rechazado; API caída a mitad → error accionable y recuperación, sin pantallas
  blancas ni "(Not Found)".
- **C — "Agoto y recargo"**: consumo hasta la gracia → avisos en campana/panel → el
  asistente responde "¿cuánto me queda?" con el número real → recargo (checkout mock) → el
  saldo sube en la UI.
- **D — "Marca ajena / TuBot intacto"** (`jornada-d-marca-ajena.spec.ts`, ✅): una cuenta
  `brand='tubot'` que entra a conversia-web NO ve la burbuja, no ve "(Not Found)" crudo, y
  "Pedir ayuda" cae a soporte. Control positivo: una cuenta conversia SÍ ve la burbuja.
  (El caso exacto del pantallazo de Javier — PARTE 1 del documento.)
- **G — "Pago mi plan"** (`jornada-g-pago-plan.spec.ts`): contrato el plan desde `/cobros`
  (checkout **mock**, sin cobro real) y lo veo "Actual"; vuelvo de la pasarela a
  `/cobros?pago=ok|cancelado` y a `/cobros?card=1` con un mensaje claro; y la API devuelve
  los retornos de MI marca (regresión: una org `tubot` sigue volviendo a `/billing`).
  Cubre el hallazgo 3 de la auditoría (el cliente no podía pagar desde su panel).

## Cómo correr

Con el stack Docker arriba (`pnpm sim:up`):

```bash
# Todos los proyectos (móvil + escritorio, claro + oscuro):
RUN_DUENO=1 BASE=http://localhost:3002 SIM_API=http://localhost:4000 \
  pnpm --filter @conversia/conversia-web exec playwright test como-el-dueno

# Un proyecto / un caso:
RUN_DUENO=1 ... pnpm ... exec playwright test como-el-dueno --project=desktop --grep "tubot"
```

Sin `RUN_DUENO=1` la suite se SALTA (necesita API real).

## CI (`.github/workflows/e2e-dueno.yml`)

Levanta el stack Docker (`pnpm sim:up`) y corre con `--workers=2 --retries=1` (el sim es un
solo contenedor; así no hay falsos rojos por sobrecarga):
- **En cada PR** que toca el producto (conversia-web / api / worker / packages / tools/sim):
  subconjunto **crítico** = Jornada A (viaje completo) + Jornada B + Jornada D, en
  desktop+iphone (`--grep "viaje completo|me cuida|marca ajena"`).
- **Nightly** (cron) y manual (`workflow_dispatch`): la suite **completa** (14 rubros,
  Jornada C y todos los dispositivos).

> Nota de verificación local: correr los 5 proyectos a la vez satura el único contenedor del
> sim (falsos rojos por timeout). Verifícalo por proyecto (`--project=desktop`, luego
> `--project=iphone`), que es como está probado. El CI usa `--workers=2 --retries=1`.

## Fixtures (`_fixtures.ts`)

- `registerAccount(request, { brand })` — registra vía API fijando la marca por el `Origin`
  (localhost → conversia; otro host → tubot). El JWT no lleva marca → un token tubot
  autentica en conversia-web y el gate del asistente responde 404 (reproduce el pantallazo).
- `useSession(page, token)` — inyecta el token en `localStorage` antes del paint y captura
  `window.open` para verificar el fallback de soporte.
- `armarCanalesConPopupBloqueado(page)` — Meta "configurado" + SDK bloqueado → camino del
  popup bloqueado, determinista.
- `collectConsoleErrors(page)` — colector de errores de consola (la suite falla si hay
  errores no esperados).
