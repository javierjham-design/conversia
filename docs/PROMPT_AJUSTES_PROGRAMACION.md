# PROMPT DE DESARROLLO — AJUSTES PENDIENTES EN UN SOLO PASE (salud de tokens + registro insertado + prueba real)

**Para el desarrollador (Claude Code en VS Code, con agentes).** Hoy (21-oct-2026) se
completó por primera vez una sesión real de **Embedded Signup de punta a punta** con la
configuración de Conversia (evento `FINISH`, cuenta creada). Del proceso salieron
hallazgos que hay que convertir en código, y además hay trabajo previo a medio terminar
en el working tree. Este prompt consolida TODO lo pendiente de programación en un solo
pase, por bloques y en orden.

> Contexto operativo: Railway tiene los deploys **pausados** ("Limited Access" del plan
> Hobby). Committea y abre PRs igual — los deploys salen solos cuando se reanude la
> cola. **TuBot está en producción y no se toca su funcionamiento.**

## ⚠️ ANTES DE EMPEZAR — estado del working tree

En el checkout hay cambios **sin committear** de una sesión anterior (banner de canal
caído en `apps/conversia-web/src/app/canales/page.tsx`, `apps/worker/src/channel-auth.ts`,
`apps/worker/src/channel-token-health.test.ts`, `apps/api/src/health.controller.ts`,
`apps/api/src/platform/platform.controller.ts`, páginas de admin/alerts, y más).
**No los descartes**: son el avance parcial del Bloque 1. Revísalos, intégralos y
committéalos como parte del trabajo de abajo.

**CORRECCIÓN 23-oct (manda sobre cualquier versión anterior de este documento):** los
extras del FB.login **NO deben llevar `features: [{name:"app_only_install"}]`** — ya se
quitó del código; mantenerlo fuera. App-Only Install es otro producto (compartir cuentas
de API existentes) y **no incorpora usuarios de la app de WhatsApp Business**: enviarlo
bloqueaba el enrutamiento a coexistencia. Los extras correctos de coexistencia son
exactamente: `{ version: "v4", setup: {}, featureType: "whatsapp_business_app_onboarding",
sessionInfoVersion: "3" }`. Contexto adicional: con el cambio **"Phone Number First"**
de Meta (changelog 3-sep-2026, despliegue en curso) el diálogo pide el número al inicio
y enruta a coexistencia AUTOMÁTICAMENTE cuando el número usa la app de WhatsApp
Business — ya no existe el selector de "cuenta existente". Todo el trabajo debe
alinearse a la doc vigente (octubre 2026): registro insertado v4, Graph v26, nada
basado en v2/v3 (deprecados el 15-oct-2026).

---

## BLOQUE 1 — Salud de tokens (prioridad 1)

Ejecuta COMPLETO `docs/PROMPT_SALUD_TOKENS.md`. Resumen del porqué: el 19-oct los
tokens de TuBot murieron y la plataforma quedó **muda sin avisar** — la salud actual es
solo por webhooks (pasiva) y el canario no valida tokens. El prompt pide: chequeo
activo cada 15 min contra Graph (`GET ?fields=id` con el token del canal), fail-fast
ante error 190, excepción operativa `token_invalido`, aviso al dueño y runbook de
rotación. Integra el trabajo parcial que ya está en el working tree (tests
`channel-token-health.test.ts` incluidos) y déjalo todo en verde.

## BLOQUE 2 — Ajustes del registro insertado (hallazgos del 21-oct)

Contexto: la configuración del dashboard quedó completa (token de sistema, número
preverificado, webhook verificado con 14 campos, app publicada). La sesión real desde
el panel de Meta terminó en `FINISH` y creó la cuenta "Digital-Dent Temuco". Datos
reales para pruebas (NO hardcodear en código; usarlos solo para validar):

- Cuenta creada: `waba_id 1623570605816558` · número `+1 711-922-7197`
  (`phone_number_id 1385622207969259`, estado `verified_not_registered`)
- Número preverificado en el pool del negocio Conversia/TuBot (business
  `1051306350709612`): `+1 835-277-9428` (`phone_id 30032068073059557`)
- Config de inicio de sesión coexistencia: `2936808876679070` · estándar: `997145850023471`

### 2.1 Capturar el `event` de la sesión de registro insertado
El listener de `canales/page.tsx` guarda waba/phone/business pero ignora `event` y
`current_step`. Ajustar para capturar:
- `event: "FINISH"` (flujo estándar) vs `"FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"`
  (coexistencia real) vs `"CANCEL"` (con `current_step`: en qué pantalla abandonó).
- Enviar `event` al backend junto con el code; el backend lo persiste en el canal
  (sirve para saber si el cliente conectó por coexistencia o número nuevo) y lo
  registra en el log de conexión (`/channels/connect-report` ya existe como referencia).
- UI: si fue CANCEL, mensaje honesto con el paso donde quedó ("Cerraste la ventana en
  el paso X — puedes retomar cuando quieras"), nunca un error genérico.

### 2.2 Backend: caso "cuenta ya creada, número verificado pero no registrado"
El flujo lanzado desde el panel de Meta deja cuentas a medias (code sin canjear →
número `verified_not_registered`). Cuando el dueño repite el flujo desde nuestra web
re-seleccionando esa cuenta/número, `/channels/embedded-signup` debe cubrir:
- canje del code → token,
- `subscribed_apps` sobre la WABA (idempotente),
- **register del número** (`/register` con PIN): manejar PIN nuevo y el error de PIN
  ya existente (reintentar con el PIN guardado del tenant o superficie clara),
- creación del canal idempotente (si el canal ya existe para ese phone_number_id,
  actualizar token y reactivar, no duplicar).
Tests unitarios de cada rama + test de integración con mocks de Graph.

### 2.3 "Número llave en mano" — fase 1 (preVerifiedPhone)
El launcher oficial de Meta pasa `setup.preVerifiedPhone.ids` para saltarse el SMS con
números preverificados. Implementar el mínimo útil:
- Tabla/campo para el pool de números preverificados de la plataforma (número,
  phone_id de Meta, estado: libre/asignado, marca).
- `GET /public/meta-config` (o endpoint de conexión autenticado, a tu criterio) puede
  devolver el `preVerifiedPhoneId` asignado a la org si existe.
- `canales/page.tsx`: si llega ese id, incluir `setup: { preVerifiedPhone: { ids: [id] } }`
  en los extras del FB.login (hoy va `setup: {}`).
- Flag por marca para activarlo; apagado por defecto. Documentar en el runbook el alta
  manual de números al pool (add_phone_numbers → request_code → verify_code, como se
  hizo hoy a mano con el +1 835).

### 2.4 Coexistencia: ajustes según la doc oficial (onboarding-business-app-users, leída 21-oct)
La vía `/channels/coexistence` debe reflejar el contrato real del flujo:
- El evento final es `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` y su payload trae **solo
  `waba_id`** (sin `phone_number_id`): el frontend NO debe exigir phoneNumberId en esa
  vía (hoy `finish()` falla con "Meta no devolvió la cuenta/número"); el backend
  resuelve el número con `GET /<WABA_ID>/phone_numbers`.
- **Saltarse el register** del número (ya está registrado en la app). Verificación
  opcional: `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type` →
  `is_on_biz_app: true`, `platform_type: "CLOUD_API"`.
- Tras conectar, **dentro de 24 h** y una sola vez cada uno:
  `POST /<PHONE_NUMBER_ID>/smb_app_data` con `sync_type: "smb_app_state_sync"`
  (contactos) y con `sync_type: "history"` (historial 180 días). Si el cliente declinó
  compartir historial llega webhook `history` con error `2593109` — manejarlo sin
  romper. Si se pasa la ventana de 24 h, el cliente debe desconectar y repetir.
- Mensajes enviados desde la app llegan por `smb_message_echoes` → mostrarlos en la
  Bandeja como mensajes propios (espejo). Error `131060` en messages: esperado en el
  primer mensaje o companion no soportado; no alertar.
- Límite de throughput en coexistencia: 20 msg/s fijos (documentar en runbook).
- Nota v5 del registro insertado: en v5 la coexistencia viene activa por defecto (sin
  featureType); dejar TODO para evaluar migración a v5 cuando salga de beta.

### 2.5 Webhooks: campos opcionales anotados (NO urgente, solo si es gratis hacerlo)
Dejar anotado/TODO (o implementar si el esquema ya lo soporta): suscripción futura a
`user_preferences`, `template_category_update`, `message_template_components_update`
cuando se activen difusiones en Conversia. No cambiar la suscripción de producción hoy.

## BLOQUE 3 — Prueba real en Docker (si no está ejecutado)

Si `docs/PRUEBA_REAL_RESULTADOS.md` no existe o está incompleto, ejecuta
`docs/PROMPT_PRUEBA_REAL_DOCKER.md` completo (suite Playwright "como el dueño", script
`tools/ops/reparar-marca.mjs`, fix de UX de elegibilidad del asistente). Las jornadas
nuevas de este prompt (2.1–2.3) entran a esa suite: el flujo de /canales con popup
mockeado debe cubrir FINISH, FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING y CANCEL.

## Cierre

1. Corre todo: typecheck + tests del monorepo + sim250 + suites Playwright.
2. PRs por bloque (1, 2, 3) con evidencia; squash de los cambios huérfanos del working
   tree dentro del PR del Bloque 1.
3. Entregable: `docs/AJUSTES_RESULTADOS.md` con tabla bloque × estado × evidencia y
   cualquier decisión que hayas tomado (p. ej. dónde expusiste preVerifiedPhoneId).

## Reglas duras

TuBot intacto · nada de credenciales en texto plano ni en commits · deploys pausados no
es excusa para no committear · prohibido marcar verde algo que un test o navegador no
haya visto funcionar · dry-run por defecto en todo script que toque producción.
