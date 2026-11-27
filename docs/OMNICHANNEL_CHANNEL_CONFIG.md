# Configuración avanzada de canales IG / Messenger / TikTok (spec de paridad con Respond.io)

Pedido del usuario 2026-08-20 (pantallazos de Respond como referencia). Objetivo:
que cada canal de redes tenga su página de configuración en Canales, "100%
funcional" como Respond. Requiere los permisos de la App Review en curso
(incluido `instagram_manage_comments`).

## Instagram (canal INSTAGRAM)
1. **Enlace de chat**: `https://ig.me/m/<usuario>` (computado, copiable).
2. **Nombre del canal** editable (ya existe Editar).
3. **Interacciones en historias** (toggles por canal, config JSON):
   - Respuestas a la historia → abren conversación (ya llegan por el webhook
     `messages`; hoy el parser las acepta — falta el toggle para elegir).
   - Menciones en historias → abrir conversación (webhook `story_mentions`/
     campo adicional).
4. **Respuestas privadas**: auto-DM a quien comenta (todas las publicaciones o
   específicas) con mensaje con variables — webhook `comments` + private reply
   (`instagram_manage_comments`). El comentarista se vuelve contacto al responder.
5. **Resolución de problemas**: botón "Actualizar permiso" (re-OAuth — ya existe
   "Volver a conectar con Meta") + link a estado del diagnóstico 🩺.
6. **Zona de peligro**: eliminar canal (mensajes/contactos permanecen) — ya existe.

## Facebook Messenger (canal MESSENGER)
1. **Enlace de chat**: `https://m.me/<pageId>` (computado, copiable).
2. **Nombre del canal** editable.
3. **Botón "Comenzar"** (Get Started) toggle → `messenger_profile.get_started`
   (dispara postback que abre conversación → puede gatillar flujo de bienvenida).
4. **Plantillas de Facebook** (Message Tags / mensajes fuera de 24 h estilo
   `purchase_transaction_alert`): sincronizar/enviar a aprobación de Meta,
   listado con estado e idioma — análogo a plantillas HSM de WhatsApp. Evaluar
   alcance real (Marketing Messages de Messenger requieren feature aparte).
5. **Respuestas privadas**: auto-DM a quien comenta una publicación de la
   página (seguimiento: cualquier publicación / específicas) — webhook `feed` +
   private replies (`pages_messaging` + `pages_read_user_content`/`pages_manage_engagement` — VERIFICAR scope y sumarlo a review si falta).
6. **Menú del chat** (persistent menu): botones web_url/postback +
   "permitir entrada de usuario" → `messenger_profile.persistent_menu`.
7. **Resolución de problemas** + **Zona de peligro**: igual que IG.

## TikTok (canal nuevo TIKTOK — NO implementado; línea de trabajo propia)
Specs de Respond (pantallazos 2026-08-20). Va por **TikTok Business Messaging
API** (app + review de TikTok, NO Meta): enum ChannelType TIKTOK, webhook,
identidad, envío — arquitectura análoga a IG/Messenger.
1. **Enlace al perfil**: `https://tiktok.me/<usuario>` copiable + **Generar
   código QR** (útil también para los demás canales — QR por canal).
2. **Nombre del canal** editable.
3. **Resolución de problemas**: "Actualizar permiso" (re-OAuth TikTok) + AVISO
   operativo: la cuenta TikTok debe aceptar DMs de todos, si no los message
   requests no llegan (documentarlo en la UI).
4. **Zona de peligro**: eliminar canal (mensajes/contactos permanecen).

## Requisito transversal: ELIMINACIÓN SEGURA de canales (pedido explícito)
Al eliminar CUALQUIER canal (WhatsApp/IG/Messenger/TikTok/mock): diálogo de
confirmación que exige **escribir el nombre del canal** para habilitar el botón
Eliminar (patrón Respond), con el aviso "los mensajes y contactos permanecen,
pero ya no podrás interactuar por este canal". Aplicar en Canales y en
cualquier otra vía de borrado.

## Requisito transversal de BANDEJA (pedido explícito)
El **nombre del canal** (editable por el tenant, p. ej. "TikTok Business
messaging", "Instagram · Digital-Dent") debe **figurar en la bandeja**: en la
lista de conversaciones y/o cabecera del chat, junto al ícono de la red — el
operador debe saber por qué canal habla sin abrir menús. (Hoy la cabecera
muestra el canal de WhatsApp; extender a todos los tipos.)

## Además (ya anotado antes)
- Alta de canales IG/Messenger desde la sección Canales (además de Integraciones).
- Íconos por red en la bandeja.
- Diagnóstico: listar OTRAS apps suscritas a la página (detectar receptor
  principal competidor, caso Respond).

---

## ✅ HECHO (27-nov-2026): separar la bandeja por RED, y los logos reales

Pedido del dueño: «poder filtrar las conversaciones por WhatsApp, TikTok, Instagram para
separarlas, y también poder verlas todas juntas» + «pon los logos reales de las
aplicaciones para que sea más fácil entender».

**Red ≠ conexión.** Ya existía un filtro por `channelId`, que apunta a UNA conexión (un
número). Quien tiene dos números de WhatsApp quiere ver «todo WhatsApp» junto, así que se
agregó el concepto de RED: `GET /conversations?channel=whatsapp|instagram|messenger|tiktok`.
El catálogo vive en `apps/api/src/conversations/canales-filtro.ts` y está espejado en
`apps/{web,conversia-web}/src/lib/redes.ts`; `bandeja-canales.spec.ts` compara los tres y
falla si se separan.

**La regla que evita el peor error.** Una clave desconocida devuelve **400**, no «todas»; y
una red real sin conexiones devuelve **cero**, no «todas». Filtrar de menos es peor que no
filtrar: la lista trae cosas, parece que funcionó, y uno cree estar mirando una red mientras
mira otra.

**Dónde se ve.** Fila de pestañas sobre la lista (Bandeja Pro de TuBot y Conversaciones de
Conversia), más el logo de la red en cada fila. Las dos cosas aparecen **solo si hay más de
una red conectada**: a quien solo tiene WhatsApp, una pestaña única y un logo repetido en
cada fila le quitan espacio sin distinguir nada. «Todas» —verlas juntas— es el estado
normal.

**TikTok figura en el catálogo** aunque su canal de mensajería no exista todavía. Es seguro:
el tipo nunca se le manda a Postgres (el enum no lo conoce), se compara en memoria contra
las conexiones del tenant. El día que el canal exista, la pestaña aparece sola.

**Logos reales**: `apps/{web,conversia-web}/src/components/brand-icons.tsx` (Simple Icons,
CC0). Reemplazan los iconos genéricos de lucide en Canales y en la bandeja.
