# TikTok — qué está conectado, qué falta y qué no depende de nosotros

Pedido del dueño (26-nov-2026): «armame la conexión de TikTok, muchos emprendimientos funcionan
con TikTok también y venden por ahí».

«TikTok» no es una cosa: son cuatro, con cuatro permisos distintos. Este documento separa lo que
ya funciona de lo que está bloqueado por un trámite, para no volver a investigarlo.

## 1. Events API — ✅ CONSTRUIDO

**Qué resuelve.** Un emprendimiento pone anuncios en TikTok que llevan a WhatsApp. TikTok ve el
clic, pero la venta ocurre en la conversación y **no la ve**. Entonces optimiza con lo único que
conoce: reparte el presupuesto hacia los videos que generan muchos clics, que no son los mismos
que generan clientes. Devolverle la conversión es lo que le permite aprender.

**Cómo se usa.** Integraciones → **TikTok** → pegar el ID del origen de eventos y el Access
Token (los dos salen de *TikTok Events Manager → tu pixel o conjunto de eventos → Configurar API
de eventos*) → **Probar conexión**. Después, en cualquier flujo, el paso **«Enviar evento
TikTok»**.

**Contrato** (`apps/worker/src/tiktok.ts`):

```
POST https://business-api.tiktok.com/open_api/v1.3/event/track/
Access-Token: <token del tenant>
Content-Type: application/json

{ "event_source": "crm",
  "event_source_id": "<pixel o conjunto>",
  "data": [ { "event": "CompletePayment",
              "event_time": <UNIX EN SEGUNDOS>,
              "event_id": "<runId>:<nodeId>",
              "user": { "phone": ["<sha256 hex>"], "email": ["…"], "external_id": ["…"] },
              "properties": { "value": 24990, "currency": "CLP" },
              "limited_data_use": false } ] }
```

`event_source` es **`crm`**, no `web`: nuestros eventos no pasan en una página.

### Las cinco trampas, todas con guardián en `apps/worker/src/tiktok.test.ts`

1. **TikTok responde HTTP 200 cuando RECHAZA el evento.** El error viene en el campo `code` del
   cuerpo (`0` es el único éxito). Un `if (res.ok)` da por enviado lo que nunca se registró, y
   el panel diría «enviado» mientras TikTok sigue a ciegas.
2. **Un hash normalizado distinto no calza con NADIE.** El evento se acepta igual y no sirve de
   nada. Reglas exactas: correo en minúsculas; teléfono en **E.164** (`+` y solo dígitos, hasta
   15 caracteres); identificador propio en minúsculas. Todo SHA-256 en hexadecimal.
   `+56 9 1234 5678`, `56912345678` y `(569) 1234-5678` tienen que dar **el mismo** hash.
3. **`event_time` en milisegundos.** TikTok lo lee como un año imposible y descarta el evento
   por estar fuera de ventana, sin decir que fue por eso. Va en **segundos**.
4. **Una fecha que cruzó la cola llega como TEXTO.** Un `Date` encolado se serializa a JSON;
   llamar `.getTime()` sobre el string revienta **dentro de un job**, donde nadie mira.
5. **Los nombres de evento de TikTok NO son los de Meta.** TikTok no conoce `Schedule` ni
   `Purchase`: usa `PlaceAnOrder` y `CompletePayment`. Mandarle un nombre de Meta se acepta como
   evento *personalizado*: no da error y deja de servir para optimizar, que era todo el punto.
   Es el error más fácil de cometer copiando el paso de CAPI.

### Deduplicación

`event_id` = `<runId>:<nodeId>`, que es la identidad que el propio runtime ya usa para la
idempotencia de un paso. **Tiene que ser estable entre reintentos**: con una clave aleatoria por
intento, un timeout que en realidad sí llegó contaría la conversión dos veces y le enseñaría a
TikTok que el anuncio rinde el doble de lo que rinde.

### Lo que NO se puede prometer: la atribución es por persona, no por anuncio

WhatsApp entrega un `ctwa_clid` que identifica el anuncio **exacto** del que vino alguien. Eso es
de Meta. **TikTok no tiene equivalente cuando el tráfico pasa por WhatsApp**: el identificador
del clic se pierde al salir de la app. El calce lo hace TikTok con el teléfono y el correo
(cifrados antes de salir de acá). Funciona —es lo que usa toda la industria para conversiones
offline— pero no es atribución exacta anuncio por anuncio, y así está dicho en la pantalla.

### Por qué el botón «Probar» hace una llamada REAL

TikTok no publica endpoint de validación, y su portal de documentación es una aplicación que no
sirve el texto por HTTP (no se puede verificar el contrato automáticamente). Así que la única
forma de saber que el token y el pixel sirven es mandar un evento y leer el `code`. **Aviso
honesto en la pantalla:** sin un *código de prueba* de «Probar eventos», ese evento entra como
conversión **real** en el pixel del tenant. Con código, TikTok lo deja aparte.

## 2. DM de TikTok como canal — ⛔ BLOQUEADO POR UN TRÁMITE, NO POR CÓDIGO

La arquitectura está diseñada (`docs/OMNICHANNEL_CHANNEL_CONFIG.md` §TikTok: enum
`ChannelType.TIKTOK`, webhook, identidad, envío — análogo a Instagram y Messenger) y el
disparador `tiktok_ad` está reservado. **No se puede construir todavía** porque la Business
Messaging API de TikTok exige, antes de entregar el permiso:

- cuenta de TikTok con **Acceso Avanzado** o **cuenta de empresa verificada**;
- aprobar la **Data Security and Privacy Review (DSPR)** de TikTok como desarrollador;
- en Estados Unidos, una revisión adicional;
- y queda **excluido** para cuentas registradas en el EEE, Reino Unido y Suiza (Chile sí
  califica).

**Pendiente del dueño**, en este orden: verificar la cuenta de empresa en TikTok → crear la app
en el portal de desarrolladores de TikTok → solicitar el ámbito de Business Messaging → pasar la
DSPR. Recién con el permiso otorgado tiene sentido escribir el canal. Mientras no esté, el
disparador «Anuncios de mensajería TikTok» sigue marcado *Próximamente* a propósito: ofrecerlo
sin la API sería un botón que no hace nada.

## 3. Lo que ya se puede hacer HOY sin ninguna API de TikTok

Un negocio que vende por TikTok no necesita los DM para operar con el bot: el camino real es
**video → enlace en la biografía → WhatsApp → el bot vende**. Y eso ya existe en el producto: el
disparador **Enlace / Código QR** (`link_scan`) genera un `wa.me` con un mensaje predefinido que
lleva un código único, así que se puede tener un enlace por campaña y saber por cuál entró cada
persona. Con el paso «Evento TikTok» al final del flujo, el círculo se cierra.

## 4. Fuera de alcance, anotado para no perderlo

- **TikTok Lead Generation** (formularios instantáneos → CRM), el equivalente de Meta Lead Ads.
  Necesita permisos de la API de anuncios de TikTok; es una línea de trabajo propia.
- **TikTok Shop** como fuente del catálogo comercial (junto a WooCommerce/Shopify/Bsale), para
  que el bot venda con el stock real de la tienda de TikTok.
- **Espejo automático** de los eventos CAPI hacia TikTok, como el que ya existe hacia GA4
  (`mirrorCapi`): hoy el evento de TikTok se manda solo desde el paso del flujo, a propósito,
  para no duplicar conversiones mientras nadie lo pide.
