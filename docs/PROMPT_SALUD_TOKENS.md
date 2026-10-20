# PROMPT DE DESARROLLO — SALUD DE TOKENS DE WHATSAPP: que una caída JAMÁS sea silenciosa

**Para el desarrollador (Claude Code en VS Code, con agentes).** Incidente real
(19-oct-2026): los tokens de WhatsApp de TuBot se invalidaron (migración de la cuenta
titular en Meta) y la plataforma **no avisó**: los webhooks entrantes siguen llegando
con token muerto, así que todo "se ve" normal mientras los ENVÍOS fallan uno a uno.
El monitor actual cubre salud por webhook (calidad/restricciones, meta-health.ts) y el
canario de IA — ninguno valida el token. Cerrar ese hueco:

## 1. Chequeo ACTIVO de token (cada 15 min, junto al canario)

- Por cada conexión WhatsApp activa (y por el token global del Tech Provider): llamada
  barata a Graph (`GET /{phone_number_id}?fields=id` con el token que usa el envío).
- Error 190 / OAuthException / 401 → **excepción de plataforma `token_invalido`
  (severidad crítica)** con el detalle (qué token, qué WABA/número, código de error),
  + notificación in-app Y **correo + push al super admin** (es incidente, no aviso).
  Dedupe: una por token caído, no una por minuto.
- Al recuperarse (la misma llamada vuelve a 200): evento de resolución y cierre de la
  excepción.

## 2. Detección al PRIMER síntoma (fail-fast en el envío)

- En el camino de envío saliente: si Graph responde error de autenticación (código 190,
  subcódigos de token expirado/invalidado), disparar la MISMA excepción `token_invalido`
  inmediatamente (no esperar al chequeo periódico) y marcar el mensaje FAILED con error
  claro ("token de WhatsApp inválido — reemplazar en Railway") en vez del error crudo.
- Los reintentos de BullMQ no deben martillar un token muerto: ante 190, backoff largo o
  pausa de la cola del canal hasta que el chequeo de salud vea el token vivo de nuevo.

## 3. Visibilidad

- Consola super admin: estado del token por canal (vivo/caído/última verificación) en la
  vista de canales + banner rojo global si el token del Tech Provider está caído.
- Panel del tenant: si SU canal está caído por token, el paso de Canales lo muestra en
  lenguaje humano ("conexión con WhatsApp interrumpida — nuestro equipo ya fue avisado").
- `tools/sim/smoke-prod.mjs`: nuevo check — el endpoint de salud expone
  `whatsappTokenOk: true/false` (agregar al /health o endpoint admin) y el humo falla si
  es false.

## 4. Runbook

- RUNBOOK_GOLIVE_V2.md: sección "Rotación/caída de token de WhatsApp": dónde se genera
  (Business Settings → Usuarios del sistema → token con business_management +
  whatsapp_business_management + whatsapp_business_messaging), qué variable(s) de
  Railway tocar (api y worker), y cómo verificar (el chequeo de salud en verde + mensaje
  de prueba al bot).
- Documentar el gatillo conocido: migraciones/cambios de titularidad del Business
  Manager invalidan tokens emitidos antes.

## Pruebas (Docker, browser-real donde aplique)

- Simular 190 en el provider mock → excepción crítica + correo + FAILED legible +
  pausa de reintentos. Al "restaurar" el token → resolución automática.
- Chequeo periódico detecta un token revocado SIN tráfico de por medio (ese era el
  hueco: silencio total).
- TuBot intacto; regresiones del harness en verde.

## Entregable

`docs/SALUD_TOKENS_RESULTADOS.md` con la evidencia + PRs con CI verde. Un PR.
