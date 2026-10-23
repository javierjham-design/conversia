# Ajustes de programación en un pase — Resultados

**Fecha:** 2026-10-21 · Encargo `docs/PROMPT_AJUSTES_PROGRAMACION.md` (3 bloques, en orden).
Deploys de Railway **pausados** (plan Hobby) → todo committeado y con PRs; salen solos al
reanudarse. **TuBot intacto.** Prohibido marcar verde algo que un test/navegador no haya visto.

## Tabla de resultados

| Bloque | Estado | Evidencia |
|---|---|---|
| **1 — Salud de tokens** (integra el working tree) | 🟢 **Completo** | PR **#525**. Chequeo activo 15 min + fail-fast 190 + excepción `token_invalido` + aviso al super admin + runbook §12. vitest **20/20** nuevas + **309/309** worker; e2e Docker (4 fases). Deliverable `docs/SALUD_TOKENS_RESULTADOS.md`. |
| **2.1 — Capturar `event` del registro insertado** | 🟢 **Completo** | `canales/page.tsx`: captura `event` (FINISH / FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING / CANCEL) + `current_step`; lo envía al backend; CANCEL → mensaje honesto con el paso. Backend persiste `signupEvent` en el canal (embedded + coexistencia). |
| **2.2 — Backend "cuenta creada, número verified_not_registered"** | 🟢 **Completo** | `embedded-signup` ahora usa el helper `subscribeAndRegisterWhatsapp` (subscribed_apps idempotente + register con PIN + #133005/"already" = éxito, con avisos) y **guard de colisión global** vía admin (número ya conectado en otra org → mensaje claro, no 500). Reconexión idempotente ya existía. Tests del helper **(whatsapp-onboard.test.ts)** cubren subscribe/register/133010/already/coexistencia. |
| **2.3 — Número llave en mano (preVerifiedPhone) fase 1** | 🟢 **Completo** | Modelo `PreVerifiedPhone` + migración `20261021140000_pre_verified_phones`; endpoint autenticado `GET /channels/connection-extras` devuelve el `preVerifiedPhoneId` asignado a la org (gated por flag de marca); `canales/page.tsx` lo pasa en `setup.preVerifiedPhone.ids`. Flag `META_PREVERIFIED_ENABLED_CONVERSIA` **apagado por defecto**. Alta manual del pool documentada en runbook §14. |
| **2.4 — Campos de webhook opcionales** | 🟢 **Anotado** (no urgente) | TODO en `meta-health.ts` (`user_preferences`, `template_category_update`, `message_template_components_update`) para cuando se activen difusiones. **No se tocó la suscripción de producción.** |
| **3 — Prueba real en Docker** | 🟢 **Ya estaba hecho** + jornada nueva **verde** | `docs/PRUEBA_REAL_RESULTADOS.md` existe y está verde (PRs #515/#516/#517: suite "como el dueño" A–D, `reparar-marca.mjs`, fix de elegibilidad). **Nuevo:** `jornada-e-registro-insertado.spec.ts` cubre el popup mockeado FINISH / coexistencia / CANCEL — **6/6 verde** (desktop + iphone) contra el stack Docker. |

## Decisiones tomadas

- **`preVerifiedPhoneId` se expone en un endpoint AUTENTICADO** (`GET /channels/connection-extras`),
  no en `/public/meta-config` (que es público y no debe filtrar datos por org). conversia-web lo
  consulta aparte. El pool es GLOBAL (no dato de tenant) → se lee/escribe con el cliente admin.
- **`event` se persiste en `channelConnection.config.signupEvent`** (no una tabla nueva): reusa el
  JSON de config donde ya viven `coexistence`/`metaUserId`. CANCEL no llega al backend (no hay code)
  → se maneja solo en la UI con un mensaje honesto por paso.
- **PIN del register**: el helper genera un PIN y trata "#133005/PIN ya existe" como éxito
  (idempotente). No se guarda PIN por tenant (no hay columna): ante un PIN distinto en un número con
  2FA, se **superficie el aviso** claro (opción "o superficie clara" del encargo), sin inventar un
  almacén de PIN en esta fase.
- **Flag del pool apagado por defecto** por marca (`META_PREVERIFIED_ENABLED_CONVERSIA`): con el flag
  off, el flujo de /canales es idéntico al actual (sin preVerifiedPhone).

## PRs

- **Bloque 1** → #525 `feat/salud-tokens-bloque1`.
- **Bloque 2 (+ jornada del Bloque 3)** → `feat/registro-insertado-bloque2` (PR al cerrar este pase).

## Cómo reproducir

```bash
pnpm typecheck && pnpm --filter @conversia/api test && pnpm --filter @conversia/worker test
pnpm sim:up
# Jornada del registro insertado (popup mockeado):
RUN_DUENO=1 BASE=http://localhost:3002 SIM_API=http://localhost:4000 \
  pnpm --filter @conversia/conversia-web exec playwright test como-el-dueno/jornada-e --project=desktop
```
