# Checklist Meta — Conexión WhatsApp autoservicio de Conversia

> Objetivo: que el botón **"Conectar mi WhatsApp"** de `app.conversia.cl/canales` funcione
> de punta a punta. El código ya está en prod (Bloque A / PR #483); **falta solo esta
> configuración en Meta + 1 variable de entorno.** Sin esto, el popup de Meta falla con
> "dominio no autorizado".

**App de Meta:** es la **MISMA app que ya usas** (tu app de *Tech Provider*, la de TuBot) — **App ID `2024917441656687`**. Conversia **NO tiene una app de Meta aparte**: ambas marcas corren sobre esta misma app. Por eso aquí solo **AGREGAS** las URLs de Conversia a lo que ya existe.
**Dónde:** https://developers.facebook.com/apps/2024917441656687/

> ⚠️ **Aditivo — no rompe TuBot.** Agregar los dominios de Conversia NO quita los de
> `tubot.cl` ni toca la config de TuBot: solo **suma** entradas. TuBot sigue funcionando
> igual. (Verificación: en `/public/meta-config` el `appId` es `2024917441656687`, o sea
> la misma app; si algún día hubiera una app separada, ese id sería distinto.)

---

## 1. Autorizar los dominios (lo más importante)

El SDK de JavaScript de Facebook **rechaza** cargar desde dominios no listados. Hay que
agregar los dominios de Conversia en **dos** lugares:

### a) Dominios del SDK de JavaScript (Facebook Login for Business)
1. Panel de la app → **Facebook Login for Business** → **Configuración** (Settings).
2. En **"Allowed Domains for the JavaScript SDK"** agrega (uno por línea):
   - `https://app.conversia.cl`
   - `https://conversia.cl`
   - `https://www.conversia.cl`
3. Activa **"Login with the JavaScript SDK" = Yes**.
4. En **"Valid OAuth Redirect URIs"** agrega (por si acaso): `https://app.conversia.cl/` y `https://conversia.cl/`.
5. Guardar cambios.

### b) App Domains (Configuración básica de la app)
1. Panel de la app → **Configuración** → **Básica** (App Settings → Basic).
2. En **"App Domains"** agrega: `conversia.cl` (cubre los subdominios).
3. Verifica que el **dominio del sitio** (Website → Site URL) sea `https://app.conversia.cl`.
4. Guardar cambios.

---

## 2. Configuración de Embedded Signup (config_id)

El flujo usa una **configuración de Embedded Signup** (config_id). Hay dos opciones:

- **Opción simple (ya funciona hoy):** no hacer nada. El sistema **reutiliza la config de
  Embedded Signup que ya tiene TuBot** (`997145850023471`, de la misma app). El flujo de
  signup es idéntico para ambas marcas (cada cliente conecta SU propia WABA), así que
  reusarla es válido: el botón funciona una vez autorizados los dominios (paso 1).
- **Opción recomendada (config propia de Conversia):**
  1. Panel de la app → **Facebook Login for Business** → **Configurations** → **Create configuration**.
  2. Tipo: **WhatsApp Embedded Signup**. Login variation: **"General"** (permite crear o usar una WABA existente).
  3. Permisos: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`.
  4. Guardar y **copiar el Configuration ID**.
  5. En Railway (servicio **api**) → Variables → agregar:
     `META_ES_CONFIG_ID_CONVERSIA = <el config_id copiado>`
  6. Redeploy del servicio **api** (o `railway up --service api --ci`).

> Verificación: `GET https://api-production-cf8e.up.railway.app/public/meta-config?brand=conversia`
> debe devolver `appId:"2024917441656687"`, tu `configId` y `ready:true`.

---

## 3. App LIVE y permisos avanzados

1. Panel de la app → arriba, el switch **"App Mode"** debe estar en **LIVE** (no Development).
2. **App Review** → los permisos `whatsapp_business_management`, `whatsapp_business_messaging`
   y `business_management` deben estar en nivel **Avanzado** (ya lo están por TuBot — Tech Provider).
3. La app debe tener configurado el **webhook de WhatsApp** (ya existe por TuBot; mismo backend).

---

## 4. (Opcional) Línea de crédito compartida — el cliente NO paga a Meta

Si quieres que los clientes de Conversia NO tengan que configurar su propio pago en Meta
(tú absorbes el costo vía tu línea de crédito):
- Railway (api) → `META_EXTENDED_CREDIT_ID = <id de tu línea de crédito extendida>`
  (Business Settings → Pagos, o `GET /{business_id}/extendedcredits`).
- `META_CREDIT_CURRENCY` debe coincidir con la moneda de la WABA (default `USD`).
- Ya está cableado en el onboarding (`subscribeAndRegisterWhatsapp` → OBO). Si lo dejas vacío,
  el cliente configura su propio método de pago en Meta (también funciona).

---

## 5. Variables de entorno en Railway (servicio `api`) — resumen

| Variable | Para qué | Estado |
|---|---|---|
| `META_APP_ID` | App ID (token exchange + SDK) | ✅ ya `2024917441656687` |
| `META_APP_SECRET` | Secreto de la app (token exchange) | debe estar seteada |
| `META_ES_CONFIG_ID_CONVERSIA` | config_id de Conversia | ⬜ **opcional** (cae a `997145850023471`) |
| `META_GRAPH_VERSION` | versión Graph | ✅ `v26.0` (v2/v3 del ES deprecados 15-oct-2026) |
| `META_EXTENDED_CREDIT_ID` | OBO línea de crédito | ⬜ opcional |

---

## 6. Prueba de aceptación

Con los pasos 1–3 hechos, desde una cuenta de prueba en `app.conversia.cl/canales`:
1. Click **"Conectar mi WhatsApp"** → abre la ventana de Meta.
2. Elegir el negocio y el número de WhatsApp Business → autorizar.
3. La página muestra los estados en vivo (conectando → registrando → plantillas) → **"Conectado"**.
4. El checklist "Conecta tu número" se marca solo.
5. Si algo falla, aparece el mensaje accionable + botón **"pedir ayuda al asistente"**.

Si el popup no abre o dice "dominio no autorizado" → revisar el **paso 1** (dominios del SDK).
Si abre pero falla al registrar → revisar que la app esté **LIVE** (paso 3) y el `config_id` sea válido.
