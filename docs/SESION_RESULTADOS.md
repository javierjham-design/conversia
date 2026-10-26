# Sesión, cerrar sesión y token vencido (conversia-web) — Resultados

**Fecha:** 2026-10-26 · Encargo `docs/PROMPT_SESION_LOGOUT.md`. Hallazgo de producción: la sesión
del panel vence a las 12 h y el frontend no lo manejaba (panel con sesión muerta, el Asistente
mostraba errores que no eran, y no había botón de cerrar sesión). **TuBot intacto** (ver §TuBot).
Regla cumplida: nada marcado verde que un test o el navegador no haya visto funcionar.

## Tabla de resultados por bloque

| Bloque | Estado | Evidencia |
|---|---|---|
| **1 — Sesión vencida global** | 🟢 Completo | `lib/api.ts`: ante **401** en llamada autenticada → intenta refrescar (Bloque 3) y, si no puede, `clearToken()` + `location.replace("/login?expirada=1&volver=<ruta>")`. Excluye rutas de auth (login/register/refresh/logout) → el 401 por contraseña mala **no** redirige en bucle. `app/page.tsx` (landing) y `AppShell` validan el `exp` del JWT client-side (sin red): token vencido sin refresh → limpia y muestra login/landing, nunca panel muerto. `/login` muestra el aviso "Tu sesión expiró…" y tras entrar vuelve a `volver`. **unit 6/6** + **e2e jornada F** (token vencido → aviso → login → vuelve a /clientes). |
| **1 — Asistente no traga el 401** | 🟢 Completo | `SupportWidget.tsx`: el `catch` ahora corta en `status === 401` (la sesión expiró, `lib/api` ya redirige) → jamás muestra el falso "No pude responder en este momento 🙏". El resto de componentes solo hacen `setError`/`catch(()=>{})`; con la redirección en curso su mensaje es moot (la página navega). |
| **2 — Cerrar sesión** | 🟢 Completo | Botón **"Cerrar sesión"** (ícono `LogOut`) en `AppShell`: al final del **riel** (escritorio) y en la hoja **"Más"** (móvil); además una sección **Sesión** en **Ajustes**. Llama `logout()` = `POST /auth/logout` (revoca el refresh, best-effort) + borra ambos tokens + va a `/login`. **e2e jornada F** (cerrar sesión desde el shell → /login, token borrado). |
| **3 — Sesión deslizante (móvil)** | 🟢 Completo | **Refresh token** opaco de larga vida (30 d, **rotativo**, **revocable**), en **Redis** (mismo patrón que las sesiones de super admin), guardado aparte del access token (12 h). `lib/api.ts` ante 401 renueva **una** vez con el refresh y reintenta; si el refresh también falla, recién ahí corre el flujo del Bloque 1. Duraciones por env (`JWT_EXPIRES_IN`, nueva `JWT_REFRESH_EXPIRES_IN`), nunca hardcodeadas. |
| **3 — Acciones sensibles / passkeys** | 🟢 Anotado | Re-login para acciones sensibles: ver §Acciones sensibles (no se implementa como compuerta dura aún; sí revocamos todas las sesiones al **cambiar contraseña**). Passkeys/WebAuthn = Fase 2, solo diseño apuntado (ver `docs/RUNBOOK_GOLIVE_V2.md` §15). |

## Qué quedó implementado

### API (`apps/api`)
- **`auth/refresh-session.service.ts`** (NUEVO): refresh tokens en Redis. Token opaco `rt_<rand>`;
  en Redis vive su **SHA-256** (nunca en claro), clave `csess:<hash>` con TTL propio + set por
  usuario `csess:user:<id>` para "cerrar todas". `create`/`resolve`/`revoke`/`revokeAllForUser`.
  **Fail-closed al resolver** (Redis caído → refresh inválido → re-login, nunca acceso a ciegas);
  **fail-open al crear/revocar** (un corte de Redis no tumba el login). Parser de duración puro
  `parseDurationSeconds` ("30d"/"12h"/"3600") → **unit 3/3**.
- **`auth/auth.service.ts`**: `issueTokens` ahora async y emite también el `refreshToken`
  (login, register, Google, MFA, switch). Nuevos `refresh()` (valida refresh → re-resuelve la
  membresía → emite access nuevo + **rota** el refresh) y `logout()` (revoca). `revokeAllSessions()`.
- **`auth/auth.controller.ts`**: `POST /auth/refresh` y `POST /auth/logout` (**públicos**: se
  autentican por el refresh del body, no por el access —que puede estar vencido—; rate-limit en
  refresh). Al **cambiar contraseña** se revocan todas las sesiones deslizantes.
- **`tenancy/tenancy.middleware.ts`**: `/auth/refresh` y `/auth/logout` a `PUBLIC_PREFIXES`.
- **`app.module.ts`**: registra `RefreshSessionService`. **`packages/config`**: `JWT_REFRESH_EXPIRES_IN` (default `30d`).

### Frontend (`apps/conversia-web`)
- **`lib/api.ts`**: sesión (`setSession`/`getRefreshToken`/`clearToken` borra ambos), `jwtExp` y
  `sessionActive` (puras), 401 → refresh único coalescido + reintento o `/login?expirada=1&volver=`,
  y `logout()`. `volver` se sanea (solo rutas internas → anti open-redirect).
- **`app/page.tsx`** (landing) y **`components/AppShell.tsx`**: guard que valida el `exp` client-side.
- **`app/login/page.tsx`**: aviso "sesión expiró" + regreso a `volver`; guarda la sesión completa.
- **`app/ajustes/page.tsx`** + **`AppShell`**: botón Cerrar sesión. **`app/registro/page.tsx`**: `setSession`.

## Duraciones elegidas
- **Access token:** `JWT_EXPIRES_IN` = **12 h** (sin cambios; sigue siendo el techo stateless).
- **Refresh token:** `JWT_REFRESH_EXPIRES_IN` = **30 d**, rotativo (cada uso corre la ventana 30 d
  desde ahora) y revocable. Pensado para el cliente móvil: no re-login cada 12 h, sí tras 30 d de
  inactividad o al cerrar sesión / cambiar contraseña. Ambas por env, sin hardcodear.

## Acciones sensibles (anotado, sin compuerta dura)
Dónde aplicaría exigir re-login aunque la sesión deslizante esté viva: **cambio de contraseña**
(`POST /auth/change-password`) y **datos de cobro** (`/cobros`, settings de pasarela). Hoy: al
cambiar la contraseña ya se **revocan todas** las sesiones deslizantes del usuario (otros
dispositivos/robos). Una compuerta de re-auth reciente (como el `reauthAt` del super admin) queda
apuntada para cuando se priorice; no se implementó en este pase por alcance.

## TuBot (apps/web) — hallazgo, NO tocado
`apps/web` comparte la MISMA API y la clave `conversia_token`, y hace `/auth/login`. Al emitir
ahora `{ token, refreshToken }`, apps/web **solo lee `token`** (ignora el refresh) → **sigue con
sesión de 12 h, comportamiento idéntico**. Además apps/web **ya tiene** su propio "Cerrar sesión"
(`app/(app)/layout.tsx`) y su manejo de error de token (`lib/api.ts`). No se modificó nada suyo.
Follow-up (requiere OK del dueño): si se quiere la misma sesión deslizante en TuBot, cablear
`setSession` + el refresh-en-401 en `apps/web/src/lib/api.ts` (aditivo, el backend ya lo soporta).

## Evidencia de pruebas
- **Unit (vitest):** `conversia-web` `lib/api.test.ts` **6/6** (401→clear+redirect; refresh ok
  reintenta; refresh falla redirige; login con contraseña mala no redirige; `jwtExp`/`sessionActive`).
  `api` `test/refresh-session.spec.ts` **3/3** (parser de duración). Suites completas: **api 179/179**,
  **worker 318/318**, monorepo typecheck **19/19**.
- **E2E (Playwright, `RUN_DUENO=1` contra Docker):** `jornada-f-sesion.spec.ts` — (1) token vencido
  sin refresh → `/login?expirada=1&volver=/clientes` + aviso → login → vuelve a `/clientes`; (2)
  Cerrar sesión desde el shell → `/login` con la sesión borrada.

## Cómo reproducir
```bash
pnpm typecheck && pnpm test                       # incluye los unit nuevos
pnpm sim:up                                        # stack Docker (api :4000, web :3002, redis)
RUN_DUENO=1 BASE=http://localhost:3002 SIM_API=http://localhost:4000 \
  pnpm --filter @conversia/conversia-web exec playwright test como-el-dueno/jornada-f --project=desktop
```
