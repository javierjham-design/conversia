# App Review de Meta — convertir CONVERSIA en Proveedor de Tecnología

Objetivo: habilitar que **otros negocios (tenants) conecten su propio WhatsApp** desde nuestro panel con
**Embedded Signup** (flujo tipo Respond), sin crear apps ni pegar tokens. Para eso Meta exige **Acceso Avanzado**
a los permisos de WhatsApp, que se obtiene por **App Review**.

**Marca comercial:** TuBot (dominio `tubot.cl`). **App de Meta:** actualmente llamada `CONVERSIA` · App ID
`2024917441656687` · Business: Digital-Dent Temuco (verificado ✅). *(Opcional pero recomendado: renombrar la app
de Meta a "TuBot" en Configuración → Básica, para consistencia en el popup de Embedded Signup.)*

> ⚠️ Las URLs `https://www.tubot.cl/...` requieren que el dominio esté **apuntado a Railway** (dominio personalizado
> en el servicio `web` + CNAME en el DNS). Hasta entonces, las páginas siguen accesibles en la URL de Railway.

## Decisión de negocio (2026-07-27)
La **plataforma cobra directo a los tenants y paga directo a Meta** las conversaciones de WhatsApp; el tenant
solo le paga a la plataforma. Implica que, al conectar la línea de crédito de WhatsApp, el método de pago ante
Meta es el **de la plataforma**, no el del tenant. (Modelo Tech Provider, como Respond.)

## Permisos que se solicitan
| Permiso | Para qué | Acceso |
|---|---|---|
| `whatsapp_business_messaging` | Enviar y recibir mensajes en nombre del tenant | Avanzado (App Review) |
| `whatsapp_business_management` | Gestionar WABA/números/plantillas y el Embedded Signup | Avanzado (App Review) |

## Prerrequisitos (checklist antes de enviar)
- [x] Verificación del negocio (Meta) — **hecha**.
- [x] Producto WhatsApp agregado a la app — **hecho**.
- [ ] **Páginas legales publicadas** (ya creadas en el panel; requieren deploy):
  - Privacidad: `https://www.tubot.cl/legal/privacidad`
  - Términos: `https://www.tubot.cl/legal/terminos`
  - Eliminación de datos: `https://www.tubot.cl/legal/eliminacion-datos`
- [ ] En **Configuración de la app → Básica**: pegar esas 3 URLs (privacidad, condiciones, eliminación de datos),
      elegir **Categoría** y subir **ícono** de la app.
- [ ] Completar razón social / dirección reales en las páginas legales (hoy con placeholders).
- [ ] App en modo **Live** (interruptor superior) — requiere privacidad + negocio verificado.
- [ ] **Registro como Proveedor de tecnología** (WhatsApp → Configuración de la API → "Registro de proveedores de
      tecnología").
- [ ] **Embedded Signup** implementado y demostrable (lo construye Claude — ver abajo).

## Textos para el formulario de App Review (copiar/pegar)

**Descripción general del caso de uso:**
> TuBot es una plataforma SaaS multi-tenant de atención al cliente por WhatsApp. Cada empresa cliente conecta
> su propia cuenta de WhatsApp Business mediante Embedded Signup y gestiona sus conversaciones con agentes de IA y
> su equipo humano. TuBot envía y recibe mensajes en nombre de cada empresa y administra sus números,
> plantillas y suscripciones de webhook.

**Justificación `whatsapp_business_messaging`:**
> Lo usamos para enviar y recibir los mensajes de WhatsApp de cada empresa cliente dentro de su ventana de
> atención: recibimos los mensajes entrantes por webhook y respondemos con agentes de IA o con el equipo humano
> del cliente desde nuestra bandeja.

**Justificación `whatsapp_business_management`:**
> Lo usamos para el Embedded Signup (conectar la WhatsApp Business Account del cliente), registrar la suscripción
> de webhook del número, consultar el estado/calidad del número y gestionar plantillas de mensaje.

**Instrucciones para el revisor (test steps):**
> 1. Ingresar al panel de demostración: `https://www.tubot.cl` con las credenciales de
>    prueba provistas en el campo de credenciales.
> 2. Ir a **Canales → Conectar canal → WhatsApp Cloud → Conectar con Meta** para ver el flujo de Embedded Signup.
> 3. Ir a **Bandeja**: se muestra una conversación real de WhatsApp con respuesta automática del agente de IA.
> 4. Enviar un mensaje desde WhatsApp al número conectado y observar la respuesta en la bandeja.

## Guion del screencast (Meta exige video)

Meta pide **dos videos separados** (uno por permiso, según el flujo de Tech Provider 2026):

### Video 1 — `whatsapp_business_messaging` (enviar mensajes)
1. Mostrar el panel y el botón **Conectar con Meta** en Canales.
2. Ejecutar el **Embedded Signup**: seleccionar/crear WABA y número, autorizar.
3. Mostrar el número ya conectado en Canales.
4. Enviar un WhatsApp real al número → mostrar el mensaje entrante en la **Bandeja** y la **respuesta del agente**.
   El video debe mostrar **ambos lados**: la app enviando y la interfaz de WhatsApp (web o móvil) recibiendo.
5. Mostrar brevemente las páginas de **privacidad** y **eliminación de datos**.

### Video 2 — `whatsapp_business_management` (crear una plantilla de mensaje)
Requisito textual de Meta: "un único video por separado que muestre la **creación de una plantilla de mensaje
de WhatsApp** para tu caso de uso". Se graba desde NUESTRO panel (implementado 2026-07-29, sección Canales →
botón **Plantillas** del canal WhatsApp):
1. Login en `www.tubot.cl` → **Canales** → canal WhatsApp → botón **Plantillas** (se ve la lista real de la WABA).
2. **Nueva plantilla**: llenar nombre (p. ej. `recordatorio_cita`), categoría **Utilidad**, idioma Español,
   cuerpo con variables — p. ej. `Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}. Responde CONFIRMAR.`
   — y los **valores de ejemplo** de cada variable (Meta los exige). Opcional: pie y botones de respuesta rápida.
3. **Crear plantilla** → mostrar el aviso de éxito y la plantilla en la lista con estado **En revisión (PENDING)**.
4. Abrir el **WhatsApp Manager** de la WABA y mostrar la MISMA plantilla recién creada ahí (prueba de que la app
   la creó de verdad vía API `POST /{waba_id}/message_templates`).
5. Cierre: pulsar **Actualizar** en el panel; si Meta ya la aprobó, se ve el badge **Aprobada**.

**Llamadas de prueba a la API** (requisito "API test calls"): las llamadas reales que hace la app al crear/listar
plantillas ya cuentan como actividad de la app en Graph (tardan hasta 24 h en reflejarse en el formulario de
revisión). Alternativa manual: la colección Postman publicada de WhatsApp Business Platform con el token del
usuario de sistema (`GET /{waba_id}/message_templates` y `POST .../message_templates`). Hacer las llamadas 1 día
ANTES de enviar la revisión.

## Qué construye Claude (🤖) para que la revisión pase limpio
- **Botón "Conectar con Meta" (Embedded Signup)** en la página de Canales: SDK JS de Meta (`FB.login` con la
  configuración de WhatsApp Embedded Signup) + endpoint de intercambio de `code` → token por WABA.
- **Token por-canal** (hoy el worker usa el token global): guardar y usar el token de cada WABA conectada.
- Requiere de tu lado: crear la **"configuración de Embedded Signup"** en la app (Meta genera un `configuration_id`
  que necesito para el SDK).

## Pasos para enviar (los haces tú en el dashboard de Meta)
1. Deploy de las páginas legales (aprobar el push).
2. Completar Básica (URLs legales + categoría + ícono) y pasar la app a **Live**.
3. Completar **Registro de proveedores de tecnología**.
4. Ir a **Revisión de la app → Permisos y funciones**, solicitar `whatsapp_business_messaging` y
   `whatsapp_business_management`, pegar las justificaciones, subir el screencast y las credenciales de prueba.
5. Enviar. Meta suele responder en **días**; se puede iterar si piden ajustes.

> Nota honesta: los requisitos y pantallas exactas de Meta cambian con el tiempo; seguir también las indicaciones
> que muestre el propio dashboard. Este documento cubre la sustancia y los textos.

## Etapa 2 — Marketing (CAPI + Lead Ads) — PENDIENTE
Decisión 2026-07-27: se **faseó**. La Etapa 1 (solo permisos de WhatsApp) va primero para no frenar la aprobación
del core; la Etapa 2 se envía en una **segunda revisión** con el core ya vivo. Permisos/productos a agregar:
- `ads_management` (Avanzado) — gestionar datasets/conjuntos de datos y enviar **CAPI** de forma programática por tenant.
- `leads_retrieval` (Avanzado) — leer leads de **Lead Ads** ("cliente potencial") de otros negocios.
- `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` — acceso a la Página + suscribir el webhook `leadgen`.
- `business_management` — gestión de activos del negocio en el onboarding.
- Producto **Marketing API**.

El código de CAPI + Lead Ads **ya existe** (worker: `meta-leads.ts`, `capi.ts`; UI en *Integraciones → Meta*): lo que
gatea la producción son estos permisos. **Atajo para el piloto** (CAPI sin permisos nuevos): el tenant genera el
**token de su dataset** en Events Manager y lo carga; con eso se envían conversiones de una. Falta un ajuste de
código menor: leer el `referral`/`ctwa_clid` del anuncio Click-to-WhatsApp que ya llega en el webhook de `messages`.

### Etapa 2b — Catálogo de anuncios (`ads_read`) — para el selector de campañas del trigger

El trigger "Anuncios Click-to-Chat" del constructor de flujos permite elegir campañas/anuncios reales desde un árbol
(campaña → conjunto → anuncio) en vez de pegar un `ad_id`. Para leer ese catálogo del negocio del tenant se necesita:

| Permiso | Para qué | Nivel |
| --- | --- | --- |
| `ads_read` | Leer campañas/conjuntos/anuncios de la(s) cuenta(s) publicitaria(s) del tenant (Marketing API) | Avanzado (App Review) |
| `business_management` | Listar las cuentas publicitarias del Business del tenant | Avanzado (App Review) |

- **Caso de uso (para el formulario):** «El negocio conecta su cuenta de Meta Business una vez y elige, desde un árbol
  de sus propias campañas y anuncios Click-to-WhatsApp, cuáles activan sus automatizaciones de atención en Conversia.
  Solo lectura de metadatos de anuncios (nombres, estado, id); no se crean ni editan anuncios.»
- **Video:** conectar la cuenta → abrir un flujo → elegir "Anuncios seleccionados" → mostrar el árbol de campañas del
  negocio → seleccionar una campaña → guardar. Dejar claro que es **solo lectura**.
- **Mientras NO esté aprobado (modo desarrollo):** funciona con las cuentas donde el usuario que conecta es
  **administrador** (roles de la app en Meta). Para cuentas de terceros, la UI muestra el aviso "No podemos listar tus
  anuncios todavía — falta `ads_read` (App Review)". El resto del trigger (ad_id manual, "Todos los anuncios") sigue
  funcionando sin este permiso.
- **Ya implementado en Conversia:** modelo `meta_ads`, sincronización con paginación + backoff (`meta-ads-sync.ts`),
  fan-out diario, endpoints `ads/accounts | ads/sync | ads/catalog`, árbol en el trigger, matching por campaña y nombres
  de campaña/anuncio en la bandeja. Reusa la conexión Meta unificada (`MetaBusinessConnection` + `appScopes`); `ads_read`
  se suma a los scopes acumulativos. **Pendiente:** el flujo de autorización con `ads_read` (Facebook Login for Business)
  para que un tenant no-admin conecte sus anuncios — hoy usa el token de la conexión existente si ya tiene el scope.

---

## Estado de la postulación — verificado por MCP 2026-08-04 (checklist anti-rechazo)

App **TuBot** `2024917441656687`. Submission **PENDING** (`2026955961452835`, enviada
~2026-08-01, `review_completed_time: null` = aún sin veredicto). **No hay nada que
reenviar** — la postulación ya está en la cola de Meta. `can_submit: false` porque
hay una en proceso (es lo esperado, no un error).

**Gates formales que Meta exige — TODOS PASAN (`app_settings_valid`):**
- ✅ `has_privacy_policy: true` → https://tubot.cl/legal/privacidad (carga 200 público).
- ✅ `business_verification_passes: true` (negocio verificado).
- ✅ App en Producción (`live_mode`), categoría MESSAGING, Términos + Eliminación de datos cargados.
- ✅ Permisos correctos en la solicitud: `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`, `whatsapp_business_manage_events`, `public_profile`. (`ads_read` NO está — se pide aparte cuando se venda conexión de anuncios de terceros.)
- ✅ `data_use_checkup` completado en todos los permisos.

**Lectura de los pasos `screencast`/`api_precheck` en `requirements`:** aparecen
`is_completed:false` PERO eso es el formulario de una **submission nueva** (reseteado
porque hay una viva); **no** significa que falten los videos ya enviados en la
submission PENDING. (Gotcha ya documentado.)

**Por qué Meta podría rechazar (lo único que depende de ti, pre-empt):**
1. **El video/screencast no demuestra claramente el uso real** de cada permiso con login real y flujo end-to-end. Es la causa #1 de rechazo. No verificable por MCP.
2. **El usuario de revisión no puede entrar o el flujo está roto.** Meta entra con las credenciales que diste (`revisor.meta@tubot.cl`, tenant piloto Digital Dent). Si está desactivado o el flujo no reproduce, rechazan.
3. **La app no está llamando las APIs** (señal de `api_precheck`). Como WhatsApp está vivo y CAPI funciona, debería estar OK; mantener la integración activa.

**Qué hacer HOY (no acelera la cola, pero evita el rechazo):**
- [ ] Entrar con `revisor.meta@tubot.cl` y verificar el recorrido completo: login → conectar WhatsApp visible → enviar/recibir un mensaje. Que el revisor pueda reproducir lo que muestra el video.
- [ ] Confirmar que la política de privacidad y los términos cargan públicos (ok hoy).
- [ ] NO desactivar el canal de prueba ni borrar plantillas mientras dure la revisión.
- [ ] NO cancelar ni reenviar la submission (te manda al final de la cola).
- [ ] (Opcional, benigno) verificar el email de contacto de la app — no afecta la submission.

**Tiempo esperado:** revisión de permisos de WhatsApp/Business suele resolverse en
**1–2 semanas** (a veces en días). Enviada ~2026-08-01 → dentro de la ventana normal.
No hay forma de acelerar la cola; solo se puede evitar el rechazo por forma.
