# PROMPT DE DESARROLLO — CONEXIÓN SIMPLE: WhatsApp en 3 minutos para clientes SIN página y SIN cuenta de Meta

**Para el desarrollador (Claude Code en VS Code, con agentes).** Decisión de negocio
(Javier, 17-oct-2026): el alta de WhatsApp es la mayor fricción del funnel y muchos de
nuestros clientes objetivo (barberías, talleres, estudios chicos) **no tienen página
web, no tienen página de Facebook y no tienen Business Manager** — solo tienen la app
de WhatsApp Business en su teléfono. La conexión debe dejar de ser engorrosa a TODO
nivel. Este prompt absorbe y amplía PROMPT_COEXISTENCIA_QR.md (léelo: ahí están los
detalles técnicos de coexistencia).

## La escalera (lo que se construye)

**Peldaño 0 — el bot funciona ANTES de conectar nada (ya existe, solo pulir):**
al registrarse, el cliente ya conversa con su bot en el simulador del panel. Ajuste:
que el checklist y el asistente lo digan explícito ("prueba tu bot ya; conectar tu
WhatsApp toma 3 minutos cuando quieras").

**Peldaño 1 — "Ya uso WhatsApp Business en mi teléfono" (el camino del 80 %):**
**Coexistencia por QR**. Punto CLAVE investigado: el Embedded Signup de Meta en modo
coexistencia **no exige página web, ni página de Facebook, ni Business Manager previo**
— el popup de Meta crea el portafolio de negocio en el camino con nombre + datos
básicos, el cliente escanea un QR desde su app (como vincular un dispositivo) y
conserva su teléfono y sus chats. VALIDAR contra la doc vigente de Meta los nombres
exactos (featureType de onboarding de la app de negocio, países, sync de historial) y
los webhooks de eco (`smb_message_echoes`) para que lo que el dueño responda a mano
desde su app aparezca en la Bandeja. Implementación backend/panel: según
PROMPT_COEXISTENCIA_QR.md. UI: "Conecta el WhatsApp que ya usas — escanea y listo.
No necesitas página web ni cuenta de Facebook."

**Peldaño 2 — "No tengo número para el negocio" / "no quiero tocar el mío":**
**Número nuevo llave en mano.** Flujo Embedded Signup estándar pero VENDIDO como
"nosotros te lo armamos": el popup crea portafolio + WABA + número nuevo (o porta uno),
con el asistente in-app guiando paso a paso y detectando en qué pantalla de Meta quedó
pegado el cliente (checklist Meta del Bloque B). Si Meta exige verificación del negocio
para subir de nivel, el asistente lo explica en cristiano y crea una excepción en la
cola del super admin para acompañamiento humano ese mismo día.

**Peldaño 3 — "No tengo página web" (valor agregado, cierra la brecha completa):**
**Mini-landing generada por Conversia.** El generador `/crear` ya lee Instagram/web
opcional; extenderlo para PUBLICAR una página pública simple del negocio hosteada por
nosotros (`conversia.cl/n/<slug>` o subdominio): nombre, rubro, servicios con precios,
horarios, botón grande de WhatsApp (wa.me del número conectado) y datos de contacto.
Se arma sola con los datos del paquete vertical + lo que el dueño edite en el panel.
Con esto el cliente SIN web queda con presencia digital + bot — argumento de venta
directo para la campaña. (SEO básico: título, descripción, OG image genérica del rubro.)

## Alcance técnico

1. **Panel Canales** (`apps/conversia-web`): pantalla única "Conectar WhatsApp" con los
   3 caminos como tarjetas (recomendado = coexistencia QR), estados en vivo
   (esperando escaneo → conectado → error con reintento) y textos sin jerga.
2. **Backend** (`apps/api` assisted-setup): modo coexistencia (start/callback/estado) +
   webhooks de eco; registrar el canal con `meta.coexistence=true`; reusar dedupe de
   wamid, free tier y débitos tal cual (mismo phone_number_id).
3. **Mini-landing** (peldaño 3): ruta pública en conversia-web + modelo/endpoint para
   los datos publicables del tenant (SOLO lo marcado como público; nada del CRM).
4. **Asistente in-app**: conoce los 3 caminos, recomienda según las respuestas del
   cliente ("¿ya atiendes por WhatsApp?, ¿quieres mantener ese número?") y el paso
   "Conecta tu WhatsApp" del checklist enlaza el flujo nuevo.
5. **Super admin**: columna del tipo de conexión + excepción si una vinculación falla.

## Criterios de aceptación (sandbox / WABA de prueba del Tech Provider)

- Un cliente nuevo SIN página y SIN cuenta Meta llega de registro a "WhatsApp
  conectado" en ≤ 3 minutos por el peldaño 1 (medido en el sandbox con un número de
  prueba que corre la app WhatsApp Business).
- Respuesta manual desde la app del dueño → aparece en la Bandeja (eco) sin duplicar.
- La mini-landing se publica desde el panel en ≤ 1 minuto y el botón wa.me abre el
  número conectado; sin datos privados expuestos (revisar con un agente de seguridad).
- Fallos de Meta (QR expirado, número no elegible, país no soportado) → mensaje claro +
  excepción en cola; jamás un 500.
- TuBot intacto; simulaciones de regresión del harness en verde.

## Proceso con agentes

1. Agente INVESTIGACIÓN: valida contra la doc vigente de Meta los supuestos del
   peldaño 1 y 2 (qué exige HOY el embedded signup con coexistencia, límites del modo,
   países) y entrega el resumen con URLs antes de escribir código.
2. Agente BACKEND (peldaños 1-2) y Agente FRONTEND (pantalla Canales + mini-landing)
   en paralelo, con contratos acordados primero (tipos en @conversia/types).
3. Agente QA: pruebas en sandbox + los criterios de arriba + regresión del harness
   (`tools/sim/sim250.mjs` fases w1/w5/w6 como mínimo).
4. Un PR por peldaño, mergeable con CI verde; causa raíz y evidencia en la descripción.
5. Entregable final: `docs/CONEXION_SIMPLE_RESULTADOS.md` + actualización del runbook
   (variables nuevas de Meta si las hay).
