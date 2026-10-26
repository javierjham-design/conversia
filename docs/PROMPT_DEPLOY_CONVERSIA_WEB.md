# PROMPT DE DESARROLLO — Publicar conversia-web y que nunca más quede atrasada

**Para el desarrollador (Claude Code en VS Code, con agentes).** Diagnóstico del 26-oct-2026
(logs HTTP de Railway + código):

- El arreglo de sesión **#533** (sesión deslizante, cerrar sesión, token vencido) está en
  `main` y la **API ya lo tiene en producción** (`POST /auth/refresh` y `/auth/logout`
  responden). Pero el servicio **`conversia-web` sigue en el deploy del 23-oct**
  (`ca001d06`). El dueño sigue viendo el panel viejo: sin botón de cerrar sesión, conversia.cl
  lo manda a un panel con la sesión muerta y el asistente responde "No pude responder".
- Evidencia: desde el navegador del dueño, **112 de 194 llamadas devuelven 401** (`/auth/me`,
  `/assistant/context`, `/cash/day`, `/agents`…) y el panel viejo las ignora y sigue
  consultando. El asistente **no tiene un error propio**: no hay ningún `✖ Asistente` en los
  logs de los últimos deploys de la API. Falla porque la sesión está vencida.
- Causa raíz del atraso: `docs/DEPLOYMENT.md` dice "Autodeploy desde main como los demás"
  para conversia-web, pero en la práctica **solo se publica con
  `railway up --service conversia-web --ci`**. La API y el worker se despliegan solos con el
  merge y la web no, así que cada cambio de frontend queda en `main` sin publicar.

## BLOQUE 1 — Publicar YA (prioridad 1)

1. `railway up --service conversia-web --ci` desde la raíz del monorepo, sobre `main`
   actualizado (incluye #533 y #534). Confirma que el build recibe
   `NEXT_PUBLIC_API_URL` (build arg).
2. Verificación en producción con navegador, no solo tests:
   - Con un token vencido en localStorage, al entrar a `conversia.cl` debe mostrarse la
     landing (o `/login?expirada=1`), nunca el panel.
   - Haz login, comprueba que el botón **Cerrar sesión** aparece (riel en escritorio y hoja
     "Más" en móvil), ciérrala y comprueba que vuelve a `/login`.
   - Con sesión válida, manda un mensaje al **Asistente Conversia** y confirma que
     `POST /assistant/message` responde 200 con texto real de la IA, no el texto mock ni el
     fallback. Revisa `railway logs --service api --http` para ese request.
3. Si el asistente falla con una sesión válida, ese es un bug nuevo: trae el status HTTP y la
   línea de log, corrígelo y vuelve al punto 2.

## BLOQUE 2 — Que la web no vuelva a quedar atrasada

- Deja `conversia-web` con **autodeploy desde `main`** igual que api/worker: servicio
  conectado al repo de GitHub, `RAILWAY_DOCKERFILE_PATH=apps/conversia-web/Dockerfile` y
  watch paths `apps/conversia-web/**` y `packages/**`. Si por algún motivo no se puede
  (límite del plan, monorepo), crea un GitHub Action que corra
  `railway up --service conversia-web --ci` en cada push a `main` que toque esas rutas
  (token de Railway como secret del repo, **nunca** en el código).
- **Sello de versión**: que conversia-web exponga el SHA del commit con el que se construyó
  (p. ej. `<meta name="x-build" content="<sha>">` o `GET /version.json`, inyectado como build
  arg). Agrega a la checklist de cierre de cada PR: "SHA publicado en web y API = SHA de
  main". Así un deploy atrasado se detecta en segundos.
- Corrige `docs/DEPLOYMENT.md` para que describa cómo se despliega realmente.

## BLOQUE 3 — Robustez menor del asistente (mismo PR, pequeño)

- `AssistantService.run()` (`apps/api/src/assistant/assistant.service.ts:222`) llama a
  `buildContext()` **fuera** del `try`. Si falla una consulta de BD (`agent.count`,
  `channelConnection.count`, `organization.findUnique`), sale un 500 y el dueño ve el
  fallback genérico. Haz que un fallo de contexto degrade a un contexto mínimo y registre
  `✖ Asistente: contexto` en el log, igual que ya se hace con el proveedor de IA. Agrega un
  test.

## BLOQUE 4 — Hallazgo de seguridad en el arranque de la API

El log de arranque de producción avisa:
`SUPER_ADMIN_SESSION_SECRET vacío → el token de plataforma comparte secreto con los de tenant`.
Documenta en el runbook el paso para que el dueño defina esa variable en el servicio `api`
(un valor aleatorio largo, distinto de `JWT_SECRET`) y qué efecto tiene: cierra las sesiones
abiertas de super admin. **No la generes ni la escribas tú en ningún archivo**; el dueño la
carga en Railway.

## Cierre

- typecheck + tests + build de conversia-web en verde.
- Entregable: `docs/DEPLOY_WEB_RESULTADOS.md` con el SHA publicado, evidencia del Bloque 1
  (status HTTP del asistente, capturas de logout y de sesión expirada), cómo quedó el
  autodeploy y el sello de versión.

## Reglas duras

TuBot intacto (`apps/web` no se toca) · nada de credenciales en texto plano ni en commits ·
prohibido marcar verde algo que no se haya visto funcionar en producción · si un deploy
falla, se informa con el log, no se reintenta a ciegas.
