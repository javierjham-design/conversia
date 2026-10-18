# PRUEBA REAL EN DOCKER — Resultados

**Fecha:** 2026-10-18 · Encargo `docs/PROMPT_PRUEBA_REAL_DOCKER.md`. Todo probado con un
**navegador real (Playwright) contra el stack Docker** (`pnpm sim:up`), **nunca producción**
(salvo la reparación de datos y el smoke de solo-lectura, explícitos). **TuBot intacto.**

> Regla aplicada: **prohibido marcar verde algo que el navegador no haya visto funcionar; se
> arregla el producto, no se baja la vara.**

## Veredicto: 🟢 El caso del pantallazo está CERRADO y la suite robusta está en verde

- El **"(Not Found)"** que vio Javier ya no ocurre: el navegador lo reproduce (rojo pre-fix) y lo
  ve desaparecer (verde post-fix). Fix de producto + regresión permanente en la suite.
- Suite "como el dueño" (jornadas A–D) **verde en navegador**, móvil y escritorio.
- **1 org mal nacida en PROD reparada** (la cuenta de prueba de Javier) sin que él cree otra.
- **conversia-web desplegado a prod** (2026-10-18) con el fix → **smoke-prod verde (9/0)** y, con una
  cuenta QA real, el asistente responde en prod con `/assistant/context` **200** y una respuesta
  **específica sobre las ventanas emergentes** (IA real viva en prod).

## PARTE 1 — El caso del pantallazo

### Antes / después (regresión UI, `jornada-d-marca-ajena.spec.ts`)

| | Antes del fix (contenedor pre-fix) | Después del fix |
|---|---|---|
| Burbuja del asistente en cuenta `brand='tubot'` | **Se mostraba** | **No se muestra** (404 del gate → inelegible) |
| Respuesta al "Pedir ayuda al asistente" | Burbuja con **"No pude responder ahora (Not Found)"** (capturado en el snapshot del test) | Cae a un **enlace de soporte** (nunca botón muerto ni error crudo) |
| `/assistant/message` desde "Pedir ayuda" | Se llamaba (y daba 404) | **No se llama** en cuenta inelegible |
| Resultado del test | 🔴 ROJO (reproduce el bug) | 🟢 VERDE 10/10 (5 navegadores) |

**Fix de producto** (PR #515, en main): `api()` adjunta el código HTTP al error; `SupportWidget`
no se monta si `/assistant/context` da 404/403; el `catch` jamás muestra el error técnico; y
`openAssistant()` hace un *handshake* cancelable para que "Pedir ayuda" caiga a soporte si no hay
asistente. **#514** (la CSP bloqueaba el SDK de Meta → "popup bloqueado" falso) también mergeado.

### Reparación de datos en PRODUCCIÓN (`tools/ops/reparar-marca.mjs`)

Dry-run por defecto; `--apply` solo con la lista revisada (`--ids`/`--emails`/`--all`). Corrige
marca + plan de prueba V2 + `users.brand` + suscripción + **regalo de 30** (idempotente) + asiento
en `audit_logs`. **No toca TuBot real.**

| Entorno | Candidatas | Reparadas | Resultado |
|---|---|---|---|
| Docker (sim) | 16 (cuentas `qa+…` de los tests) | 1 de muestra (verificación end-to-end) | login desde conversia-web OK · `/assistant/context` **200** (antes 404) · saldo **30** |
| **PRODUCCIÓN** | **1** (`abogados@gmail.com` · "ABOGADOS TEST", detectada por `settings.vertical`) | **1** → conversia + `conversia_v2_trial` + 30 | dry-run posterior: **0 orgs mal nacidas restantes** |

La cuenta de prueba de Javier quedó **funcionando sin crear otra**. Procedimiento en el runbook §10.

### Checks del asistente en smoke-prod (opt-in)

`tools/sim/smoke-prod.mjs` check 10 (SKIP sin credenciales QA, para no mutar prod por defecto):
cuenta conversia → `/assistant/context` 200 + respuesta específica sobre ventanas emergentes;
cuenta tubot → `/assistant/context` 404. Se corre con `SMOKE_QA_*` / `SMOKE_TUBOT_*` tras el deploy.

**Ejecutado en PROD tras el deploy** (cuenta QA `qa+pruebareal-<fecha>@conversia.cl`): smoke-prod
**9 PASS · 0 FAIL** (1 SKIP = consola, por diseño). Check 10 **verde completo**: `/assistant/context`
**200** · `/assistant/message` 201 (288 chars) · **respuesta ESPECÍFICA sobre ventanas emergentes**
→ la IA real está configurada y viva en prod (el asistente da respuestas útiles, no genéricas).
(De paso, el smoke cazó 2 detalles del propio check y se afinaron: `127.0.0.1` pelado del guard de
`api-base.ts` no es una URL filtrada → solo se marca host local CON puerto; y el login devuelve 201,
no 200 → se valida por la presencia del token.)

## PARTE 2 — Suite "como el dueño" (`apps/conversia-web/e2e/como-el-dueno/`)

El navegador hace EXACTAMENTE lo que hace Javier, contra Docker, con asserts sobre lo que SE VE.

| Jornada | Qué verifica | Dispositivos | Resultado |
|---|---|---|---|
| **A — Nazco (14 rubros)** | registro desde el apex por cada rubro → /inicio con 30/30 | escritorio | 🟢 14/14 |
| **A — Quedo operando** | registro → 30/30 → el asistente SALUDA y dice qué falta → 2 servicios con precio → canal MOCK + agente → cliente escribe (webhook) → Bandeja → el bot respondió → respondo a mano → crédito **30→29** en /cobros · consola limpia | escritorio + iPhone | 🟢 2/2 |
| **B — Me cuida** | popup de Meta bloqueado → banner accionable + Reintentar + "Pedir ayuda" abre la burbuja con el error (sin "(Not Found)"); API caída a mitad → "No pudimos cargar tu saldo" + Reintentar + recuperación sola, sin pantalla blanca | escritorio + iPhone + Pixel | 🟢 6/6 |
| **C — Agoto y recargo** | consumo 3 conversaciones → saldo **30→27** en /cobros → recarga (checkout mock) → saldo **sube** en la UI | escritorio + iPhone | 🟢 2/2 |
| **D — Marca ajena / TuBot** | cuenta tubot en conversia-web → sin burbuja, sin "(Not Found)", "Pedir ayuda" a soporte + control positivo (conversia SÍ ve la burbuja) | escritorio + iPhone + Pixel (claro/oscuro) | 🟢 10/10 |

**Regla permanente:** todo bug reportado entra PRIMERO como test rojo de esta suite.
**CI** (`.github/workflows/e2e-dueno.yml`): en cada PR que toca el producto → crítico A+B+D
(desktop+iphone); nightly/manual → suite completa. `--workers=2 --retries=1` (un solo contenedor).

### Lo que NO se puede marcar verde sin IA real (gated por `RUN_DUENO_AI`)

El proveedor de IA del sim es **mock** (determinista). Estos sub-pasos exigen `ANTHROPIC_API_KEY`:
cargar servicios POR EL CHAT del asistente (en la suite se cargan por el FORMULARIO, el otro
camino real); que el asistente mencione ESPECÍFICAMENTE las ventanas emergentes (B) o responda
"¿cuánto me queda?" con el número real (C). **Jamás se marcan verdes sin IA real.** (El saludo y
el contexto del asistente SÍ son deterministas — los calcula el backend — y están verificados.)

## PARTE 3 — "Corre TODO"

| Suite | Resultado |
|---|---|
| **"como el dueño"** (nueva) | 🟢 por proyecto: A 16/16 · B 6/6 · C 2/2 · D 10/10 · comando exacto del CI (crítico, desktop+iphone, workers=2) **10/10** |
| **M5 PWA** (`pwa.spec.ts`) | 🟢 12/12 (móvil+escritorio) |
| **sim250 (F1 regresión de marca)** | 🟢 verde en la Validación Final (0 crítico/alto/medio); reproducir: `WEB_URL_CONVERSIA=https://app.conversia.cl` + `node tools/sim/sim250.mjs all` (ver `tools/sim/README.md`) |
| **smoke-prod** (post-deploy, prod) | 🟢 **9 PASS · 0 FAIL** · 1 SKIP (consola). Check 10 del asistente verde: contexto 200 + respuesta específica sobre ventanas emergentes (IA real en prod) |

> Nota de verificación local: correr los 5 proyectos a la vez satura el único contenedor del sim
> (falsos rojos por timeout). La verificación se hace por proyecto; el CI usa `--workers=2 --retries=1`.

## Cómo reproducir

```bash
pnpm sim:up   # stack Docker completo (seed + golive + rate)
# Suite completa (por proyecto, recomendado):
RUN_DUENO=1 BASE=http://localhost:3002 SIM_API=http://localhost:4000 \
  pnpm --filter @conversia/conversia-web exec playwright test como-el-dueno --project=desktop
# Reparar marca (dry-run) contra prod:
railway run -s Postgres -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node tools/ops/reparar-marca.mjs'
```

## Estado del deploy y pendientes del dueño

- **Deploy a prod: HECHO** (2026-10-18). `conversia-web` desplegado desde main con el fix de
  elegibilidad (#515) + la CSP del SDK de Meta (#514). smoke-prod post-deploy 9/0.
- **IA del asistente en prod: VIVA** (el smoke obtuvo una respuesta específica real). El pendiente
  `ANTHROPIC_API_KEY` de la Validación Final era para el **sim** (mock): sigue aplicando solo para
  correr ahí los gated `RUN_DUENO_AI` y los 12 guiones + juez (`tools/sim/assistant-eval.mjs`).
- **Datos legales** en `apps/conversia-web/src/app/legal/_config.tsx` (placeholders visibles) —
  pendiente del dueño antes de abrir la campaña.
