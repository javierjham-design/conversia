# Conexión simple de WhatsApp — Resultados

**Fecha:** 2026-10-17 · **Encargo 3.** Objetivo: que un cliente **sin página web y sin cuenta de Meta conectada** llegue de registro a "WhatsApp funcionando" en ≤ 3 minutos. Un PR por peldaño, CI verde, **TuBot intacto**.

## La escalera construida

| Peldaño | Qué es | PR | Estado |
|---|---|---|---|
| 0 | El bot funciona ANTES de conectar nada (simulador en el panel) | — | ya existía; el asistente lo refuerza en el copy |
| 1 | **Coexistencia por QR/código** — conectar el número que YA usa, sin perder su app ni sus chats | #495 | ✅ en `main` |
| 2 | **Número nuevo llave en mano** — Embedded Signup + verificación de negocio acompañada | #497 | ✅ (auto-merge) |
| 3 | **Mini-landing pública** `conversia.cl/n/<slug>` con botón de WhatsApp | #496 | ✅ en `main` |

## Investigación de Meta (doc vigente, 2026-10) — lo que cambió el diseño

Un agente validó los supuestos contra la documentación oficial **antes** de escribir código. Correcciones clave:

- **featureType = `whatsapp_business_app_onboarding`** (el valor `"coexistence"` fue **retirado** por Meta en may-2025).
- En coexistencia **NO se registra el número** (`/register`) ni hace falta PIN de dos pasos: ya está registrado; la conexión por código/QR lo cubre.
- Los mensajes que el dueño manda **a mano** desde su app llegan por el webhook **`smb_message_echoes`** (array interno `message_echoes`); **no hay flag booleano** de eco → se identifica por el campo + `from`=número del negocio. Historial y contactos: `history` y `smb_app_state_sync` (se piden con `POST /<phone_number_id>/smb_app_data`, 1 vez, 24 h).
- El flujo actual de Meta es por **código de verificación** (el QR es el flujo anterior; conviven) → la UI dice *"escanea o ingresa el código"*.
- **No** exige web, página de Facebook ni Business Manager previos. **Throughput fijo 20 mps**, ventana de 24 h y plantillas igual. **Graph API v26.0**, **Embedded Signup v4**.
- **Chile (+56)**: no aparece en ninguna lista de países **restringidos** y LatAm entró temprano → muy probablemente soportado, pero **Meta no lo lista explícitamente** → validar en sandbox.

## Qué quedó en el código (resumen)

**Peldaño 1 (#495)** — todo aditivo y gateado; inerte para TuBot:
- `GET /public/meta-config?mode=coexistence` (config del popup por marca).
- `POST /channels/coexistence`: `code→token`, suscribe webhooks, **no** registra, verifica `is_on_biz_app`/`platform_type`, canal con `config.coexistence=true`. Fail-soft: cualquier fallo → excepción `coexistence_error` + **400 accionable, nunca 500**.
- Worker: parsea `smb_message_echoes` → mensajes **SALIENTES** (`authorType USER`, `payload.origin:"app"`), **dedupe por wamid**, **no** dispara al agente. Inerte para WABAs normales.
- UI `/canales` con dos caminos (coexistencia recomendada + número dedicado); asistente + super admin al tanto.
- Env: `META_ES_COEX_CONFIG_ID_CONVERSIA`, `META_ES_COEX_FEATURE_TYPE`.

**Peldaño 2 (#497)**:
- `POST /channels/connect-report` clasifica verificación de negocio → excepción `verificacion_negocio` (mayor toque) + devuelve `needsVerification`.
- UI explica la verificación en cristiano + "Que me acompañe una persona" + atajo a coexistencia; asistente sabe explicarla y escalar.

**Peldaño 3 (#496)** — sin migración (`organization.settings.miniSite`):
- `GET /public/n/:slug` (público): nombre, rubro, servicios activos con precio, horarios, botón `wa.me`, contacto. **Solo lo publicado; nada del CRM.** 404 si no es conversia o no está publicado.
- `GET|PUT /settings/mini-site` (dueño) + editor `/mini-sitio` (publica en < 1 min) + página SSR/ISR `/n/[slug]` con SEO básico.

## Criterios de aceptación

| Criterio | Estado |
|---|---|
| De registro a "conectado" ≤ 3 min por coexistencia | ⏳ requiere **sandbox del dueño** (ver abajo); flujo y copy listos |
| Respuesta manual desde la app del dueño aparece en la Bandeja sin duplicar | ✅ **verificado por tests** (parseo de `smb_message_echoes` + dedupe por wamid) — falta E2E con número real |
| Mini-landing se publica en ≤ 1 min; botón wa.me abre el número; sin datos privados | ✅ construido y revisado (endpoint solo público; 404 si no publicado) |
| Fallos de Meta (QR expirado / no elegible / país) → mensaje claro + excepción, jamás 500 | ✅ fail-soft con `coexistence_error`/`verificacion_negocio` |
| TuBot intacto; regresión del harness verde | ✅ worker 289 + api 175 tests; ecos inertes para TuBot |

## Pendiente del dueño (no verificable sin su app Meta + un teléfono real)

La app Meta de CONVERSIA (2024917441656687) **aún no autoriza los dominios Conversia**; mientras eso siga así el E2E real no corre. Pasos:

1. **App Meta (Conversia)**: autorizar dominios `app.conversia.cl` / `conversia.cl`; definir el `config_id` de coexistencia y setear `META_ES_COEX_CONFIG_ID_CONVERSIA` (si se usa una config aparte). En el **App Dashboard**, suscribir los campos de webhook del WABA: **`smb_message_echoes`**, **`history`**, **`smb_app_state_sync`**, **`account_update`** (además de `messages`).
2. **Sandbox E2E** con un número **+56** corriendo la app WhatsApp Business: iniciar coexistencia desde `/canales`, escanear/ingresar el código, confirmar canal `active` con `coexistence=true`; responder a mano desde la app → debe aparecer en la Bandeja sin duplicar. Confirma de paso la elegibilidad de Chile y si la UI es QR o código.
3. **Número nuevo**: si Meta pide verificación de negocio, confirmar que aparece la excepción `verificacion_negocio` en la cola y que el acompañamiento funciona.
4. **Mini-landing**: mapear `conversia.cl/n/*` al servicio `conversia-web` (hoy ya responde en `app.conversia.cl/n/<slug>`).

Detalle operativo (variables + webhooks) en `docs/RUNBOOK_GOLIVE_V2.md` §9.
