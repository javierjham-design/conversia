# Configuración de la app de Meta (TuBot) — pasos manuales en el dashboard

Esta es la lista de pasos que hay que hacer **a mano** en
[developers.facebook.com](https://developers.facebook.com/apps/2024917441656687/)
para terminar de integrar la app. El **código ya está listo** (endpoints de
callback + `appsecret_proof` firmado en todas las llamadas a Graph); aquí solo
queda pegar URLs y activar toggles.

> ⚠️ **NO hacer nada de esto mientras la App Review esté PENDING.** Cambiar
> settings, callbacks o el dominio del webhook durante la revisión puede
> interferirla. Esperar el veredicto y recién entonces seguir este checklist.

App ID: **2024917441656687** · Webhook actual:
`https://api-production-cf8e.up.railway.app/webhooks/whatsapp`
(sustituir el host por el dominio propio si algún día se migra).

---

## 1. Verificar el email de contacto
**Configuración → Básica → Correo de contacto.** Reenviar verificación y
confirmar desde el correo. (Hoy `contact_email_verified = false`.)

## 2. Deauthorize callback (desautorización)
**Facebook Login for Business → Configuración → "URL de cancelación de la
autorización" (Deauthorize Callback URL).**
Pegar:
```
https://api-production-cf8e.up.railway.app/webhooks/meta/deauthorize
```
Qué hace el backend al recibirlo (ya implementado): verifica el `signed_request`,
mapea el `user_id` al canal (`channel.config.metaUserId`, guardado al conectar),
deja el canal **inactivo** y la conexión Meta en **DESCONECTADA — reautorizar**,
borra la credencial cifrada y avisa al admin (evento + audit log). No borra
conversaciones ni flujos.

## 3. Data deletion callback (eliminación de datos)
**Configuración → Básica → "Devolución de datos de eliminación" (Data Deletion
Request URL).** Pegar:
```
https://api-production-cf8e.up.railway.app/webhooks/meta/data-deletion
```
El backend responde con `{ url, confirmation_code }` (URL de seguimiento en
`tubot.cl/legal/eliminacion-datos?code=…`) y registra la solicitud en
`audit_logs`. (Ya existe además la **página** legal de eliminación de datos; esto
es la versión callback que Meta también acepta.)

## 4. App secret proof (endurecer llamadas server-side)
**Configuración → Avanzada → Seguridad → "Requerir el secreto de la app para las
llamadas a la API del servidor" (Require app secret) → ACTIVAR.**
Es seguro: el backend **ya firma y envía `appsecret_proof` en todas las llamadas
a Graph** (con el toggle apagado no molesta; al activarlo, todo sigue funcionando).
Orden recomendado: activar **después** de un deploy con este cambio ya en prod
(que es este) y verificar que la bandeja envía/recibe.

## 5. 2FA para cambios de la app
**Configuración → Avanzada → Seguridad → "Se requiere verificación en dos pasos"
→ ACTIVAR** (exige 2FA a los admins para cambios sensibles de la app).

> Nota 2026-08-18: la App Review ya salió (ACTIONED 2026-08-08). Los permisos
> críticos quedaron **aprobados con acceso avanzado**: `whatsapp_business_messaging`,
> `whatsapp_business_management`, `business_management`. Rechazados (no críticos):
> `whatsapp_business_manage_events`, `email`. Ya se puede tocar la app.

## 6. Suscripción `page/leadgen` (CRM de Lead Ads)

La app hoy solo está suscrita al topic `whatsapp_business_account` (verificado
por MCP). Para que los leads de formularios lleguen al CRM hay que suscribir el
topic **`page`** con el campo **`leadgen`**:

- **Dashboard**: App → Webhooks → agregar suscripción `page`, campo `leadgen`,
  callback `https://api-production-cf8e.up.railway.app/webhooks/whatsapp`
  (el MISMO endpoint: ya verifica `hub.challenge` con `META_VERIFY_TOKEN` y el
  worker parsea los payloads `object=page/leadgen`), verify token = valor de
  `META_VERIFY_TOKEN` en Railway (servicio api).
- **O por MCP**: `devtools_webhook_manage subscribe` con `topic=page`,
  `fields=["leadgen"]`, ese callback y el mismo verify token.

Luego, **desde el panel del tenant** (Centro Meta → Lead Ads → "Páginas
conectadas"): conectar la página de las campañas — eso suscribe la app a la
página (`subscribed_apps`) y registra página+formularios para el ruteo. El
token del Usuario del Sistema debe tener la página asignada en Business
Manager. Con eso el circuito queda: formulario → webhook → CRM (`/crm`) →
reglas CAPI por etapa → dataset de Meta (`lead_id` incluido).

---

## Orden sugerido (después del veredicto de la App Review)
1. Verificar email (paso 1).
2. Pegar los dos callbacks (pasos 2 y 3) y probar: quitar/re-agregar la app en una
   cuenta de prueba y confirmar que el canal queda en "reautorizar".
3. Activar **app secret proof** (paso 4) y probar envío/recepción en la bandeja.
4. Activar **2FA** (paso 5).

## Verificación rápida por MCP (opcional)
Con el devtools MCP de Meta conectado (`/mcp` para re-autenticar):
- `devtools_app security` → confirmar `require_app_secret: true`, `require_2fa: true`.
- `devtools_app basic_settings` → `contact_email_verified: true`.
- `devtools_app advanced_settings` → `deauth_callback_url` ya no null.
