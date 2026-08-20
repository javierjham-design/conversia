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
