# Publicar conversia-web + no quedar atrás — Resultados

**Fecha:** 2026-10-26 · Encargo `docs/PROMPT_DEPLOY_CONVERSIA_WEB.md`. conversia-web estaba en el
deploy del 23-oct (`ca001d06`) mientras el fix de sesión **#533** ya estaba en `main` y en la API.
**TuBot (`apps/web`) no se tocó.** Regla cumplida: lo verde se vio funcionando en producción.

## Tabla de resultados

| Bloque | Estado | Evidencia |
|---|---|---|
| **1 — Publicar YA + verificar en prod** | 🟢 Publicado y verificado (incl. asistente) | `railway up --service conversia-web --ci`. Deploy `cbc504be` y re-publicado con sello (`871852d`). Sesión/logout verificados en navegador; **asistente verificado respondiendo 201 con texto real de Anthropic** tras #538+#539 — ver abajo. |
| **2 — Autodeploy + sello de versión** | 🟢 Implementado (autodeploy requiere 1 paso del dueño) | GitHub Action `deploy-conversia-web.yml` (push a main → stamp + `railway up`), guardada ante la falta del secret. Sello `GET /version.json`. `DEPLOYMENT.md` corregido. |
| **3 — Robustez del asistente** | 🟢 Corregido + test | `buildContext` degrada a contexto mínimo (no 500) + bug de proveedor de IA (ver §Asistente). |
| **4 — SUPER_ADMIN_SESSION_SECRET** | 🟢 Documentado | Runbook §16 (el dueño la carga en Railway; no se generó ni se escribió). |

## Bloque 1 — evidencia en producción (navegador + logs)

Script Playwright contra `https://app.conversia.cl` (deploy `cbc504be`) con la cuenta **sandbox**:

| Verificación | Resultado |
|---|---|
| Token vencido en localStorage → entrar a `/clientes` | ✓ redirige a `https://app.conversia.cl/login?expirada=1&volver=%2Fclientes` (nunca el panel) |
| Login (sandbox) → panel | ✓ entra a `/inicio` (login POST **201**, y la respuesta trae `refreshToken` → #533 vivo en la API) |
| Botón **Cerrar sesión** visible en el panel | ✓ (riel en escritorio) |
| Cerrar sesión | ✓ vuelve a `/login` y borra el token de localStorage |
| `POST /assistant/message` con sesión válida | ⚠️→🟢 responde **201** pero con el **fallback** (no texto de IA). **Bug nuevo diagnosticado y corregido** (ver §Asistente). |

Así, el problema reportado (panel con sesión muerta, sin logout, "No pude responder") queda resuelto
en la parte de **sesión/cerrar sesión**. El "No pude responder" restante NO era de sesión: era el
proveedor de IA (abajo).

## §Asistente — por qué respondía el fallback con sesión válida (Bloque 1 pto. 3 + Bloque 3)

- **Status HTTP:** `POST /assistant/message` → **201** (éxito; 201 es el default de POST en NestJS),
  pero el `reply` era el fallback `"Estoy teniendo un problema para responder…"`.
- **Línea de log (API):** `✖ Asistente: proveedor de IA no disponible (401 Incorrect API key
  provided: sk-proj-…)`. Es decir, el asistente llamaba a **OpenAI con una API key inválida**.
- **Diagnóstico:** prod tiene `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` **válida** (probado:
  `claude-sonnet-4-6` responde **200** en Anthropic) y `AI_DEFAULT_MODEL` vacío. El asistente usaba
  `createAIRouter`, que **rutea por el nombre del modelo** y, para cualquier modelo que no empiece
  por `claude`/`gpt`, **cae a OpenAI** — ignorando `AI_PROVIDER`. El `OPENAI_API_KEY` de prod es una
  llave vieja inválida → 401 → fallback. **No es un bug de #533 ni de sesión**; la sesión vencida lo
  tapaba (antes esas llamadas daban 401 por token y nunca llegaban a la IA).
- **Corrección (en este PR, API):** el asistente usa `createAIProvider({ provider: env.AI_PROVIDER, … })`
  → honra el proveedor configurado (anthropic→Anthropic, openai→OpenAI, mock→Mock). Nunca más cae a
  un OpenAI roto. Aislado a `AssistantService` (worker/TuBot intactos). Test en `assistant-context.spec.ts`.
- **Segunda capa del mismo bug (#539):** tras #538 el log pasó a `404 not_found_error "model:
  gpt-4o-mini"` — ya llamaba a Anthropic, pero con un modelo de OpenAI. Causa: `packages/config`
  define `AI_DEFAULT_MODEL` con default **`"gpt-4o-mini"`**, así que `env.AI_DEFAULT_MODEL` nunca es
  vacío y se lo mandaba a Anthropic. Fix (#539): `resolveAssistantModel(provider, model)` elige un
  modelo de la FAMILIA del proveedor (anthropic→`claude-sonnet-4-6`; respeta `AI_DEFAULT_MODEL` solo
  si coincide). Función pura + test del caso exacto.
- **VERIFICADO EN PRODUCCIÓN (2026-10-26 13:00Z):** tras el autodeploy de la API con #539,
  `POST /assistant/message` (sesión sandbox válida) → **HTTP 201** con texto real y contextual de
  Anthropic (ej.: *"…llevas un 50% de implementación y el siguiente paso es conectar tu WhatsApp…"*),
  y **cero `✖ Asistente`** en los logs. Ya no es mock ni fallback.

## Bloque 2 — autodeploy y sello de versión

- **Autodeploy:** `.github/workflows/deploy-conversia-web.yml` corre en cada push a `main` que toque
  `apps/conversia-web/**` o `packages/**`: sella la versión y `railway up --service conversia-web --ci`.
  **Requisito único del dueño:** crear el secret **`RAILWAY_TOKEN`** del repo (token de PROYECTO de
  Railway). Sin él, el job NO falla: avisa y se salta el deploy (no ensucia `main` con rojos). El
  token nunca va en el código. Alternativa equivalente: conectar el servicio a GitHub en el
  dashboard de Railway (como api/worker) y desactivar el workflow.
- **Sello de versión:** `https://app.conversia.cl/version.json` → `{ "sha": "<git sha>", "builtAt": … }`
  (estático desde `apps/conversia-web/public/version.json`, escrito por `scripts/stamp-version.mjs`).
  **Checklist de cierre de cada PR que toque la web:** `curl -s https://app.conversia.cl/version.json`
  y confirmar que su `sha` == `git rev-parse origin/main`.
- **`DEPLOYMENT.md`** corregido: ya no dice "autodeploy como los demás" (era falso); describe los dos
  caminos reales + el deploy manual + el sello.

## Bloque 3 — robustez de `buildContext`

`AssistantService.run()` armaba el contexto FUERA del `try` → un fallo de BD daba 500 y el fallback.
Ahora se envuelve en `try/catch`: si falla, degrada a un **contexto mínimo** y registra
`✖ Asistente: contexto no disponible (…)` (igual que el fallo del proveedor) → la IA responde 200
con texto real. Test: `assistant-context.spec.ts` (prisma que lanza → responde con la IA, loguea).

## Bloque 4 — `SUPER_ADMIN_SESSION_SECRET` (acción del dueño)

Documentado en `RUNBOOK_GOLIVE_V2.md §16`: el dueño define en el servicio `api` una
`SUPER_ADMIN_SESSION_SECRET` aleatoria y larga, **distinta** de `JWT_SECRET`, para que los tokens de
super admin no compartan secreto con los de tenant. **Efecto:** al definirla/cambiarla se cierran las
sesiones abiertas de super admin (re-login con MFA). **El valor lo carga el dueño en Railway; no se
generó ni se escribió en el repo.**

## Cierre — SHA publicado y verificación

- **SHA de `main` al publicar:** `8608679` (deploy `cbc504be`). El sello `/version.json` queda vivo
  tras el primer deploy que corra `stamp-version.mjs` (la Action, o el deploy manual).
- **Hecho tras los merges:** (1) la **API** autodeployó #538+#539 (deployments `e423bba8`→commit
  `871852d`, luego #539) → asistente verificado (arriba); (2) **conversia-web** re-publicado con sello
  → `https://app.conversia.cl/version.json.sha == 871852dc… == origin/main`.
- **Pendientes del dueño:** crear el secret `RAILWAY_TOKEN` (para que la web autodeploye sola) ·
  rotar/quitar el `OPENAI_API_KEY` inválido (opcional; el asistente ya no depende de él) · definir
  `SUPER_ADMIN_SESSION_SECRET` (§16). Nota: `api`/`worker` **sí** autodespliegan en el merge
  (confirmado); solo `conversia-web` necesitaba el mecanismo del Bloque 2.

## Pruebas
- `pnpm typecheck` (api/web) ✓ · `pnpm --filter @conversia/api test` **181/181** ✓ (asistente 5/5,
  incl. `resolveAssistantModel`) · build de conversia-web ✓ · verificación en producción (navegador
  para sesión/logout; API con sesión real para el asistente → 201 texto real, logs limpios).
