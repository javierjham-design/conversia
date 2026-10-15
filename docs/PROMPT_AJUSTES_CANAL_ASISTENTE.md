# PROMPT AJUSTES — Conexión de WhatsApp autoservicio + Asistente de implementación in-app

Planner, 2026-10-15. Diagnóstico verificado contra origin/main `45b1530` y la prueba
real del dueño: **la conexión WABA "no funciona" porque NO EXISTE en el panel del
cliente** — `apps/conversia-web/src/app/canales/page.tsx` es solo una lista de
estados con el texto "nuestro equipo te ayuda a conectar" (sin botón, sin Embedded
Signup, sin SDK, sin envs de Meta en conversia-web). El signup clásico vive en
TuBot/consola. Esto rompe la promesa central del V2 ("se arma solo"). Rigen
PROMPT_MAESTRO_V2 y sus reglas; un PR por bloque; CI verde; sin regresión TuBot.

---

## BLOQUE A — Conectar WhatsApp DESDE el panel del cliente (autoservicio real)

```text
TAREAS
1. Página /canales de conversia-web: reescribirla con el flujo de conexión:
   · Tarjeta WhatsApp con botón primario "Conectar mi WhatsApp" → Embedded Signup
     (FB JS SDK + config_id de la app CONVERSIA), reusando el intercambio de
     código ya existente en la API (whatsapp.controller POST + whatsapp-onboard:
     registro, OBO de línea de crédito, salud) — NO reinventar el backend.
   · La config del SDK (appId, config_id, version) se sirve desde la API por
     marca (GET /public/meta-config con brandFromOrigin) — nada hardcodeado en el
     build, para poder corregir sin redeploy.
   · Estados en vivo post-popup: conectando → registrando número → compartiendo
     línea de crédito → creando plantillas (V2-7 ya se engancha) → ✅ conectado y
     sano. El checklist "Conecta tu número" se auto-marca.
   · MANEJO DE ERRORES LEGIBLE (lo que el dueño vivió): mapear los fallos típicos
     a mensajes accionables en español: popup bloqueado · dominio no autorizado
     en la app de Meta (error del JS SDK) · usuario sin Business Manager o sin
     página de Facebook · número ya en uso en la app de WhatsApp (ofrecer la ruta
     Coexistence cuando P2 se encienda, mientras: instrucción de liberar o usar
     otro número) · PIN ya configurado (133005, el onboard ya lo detecta) ·
     permiso denegado en el popup. Cada error: qué pasó + qué hacer + botón
     "pedir ayuda al asistente" (Bloque B) que abre el chat CON el contexto del
     error ya cargado.
   · Si el intento falla 2 veces: raiseException tipo canal_conexion_fallida
     (cola V2-8) con el detalle técnico — el equipo lo ve sin que el cliente
     tenga que reportar nada.
   · Quitar los emojis-ícono de la página (🔗📱…) → SVG lucide (regla del design
     system).
2. Instagram/Messenger: mismas tarjetas con "próximamente aquí — conéctalo con
   ayuda del asistente" (el flujo OAuth de IG/MSJ queda para un PR posterior; no
   bloquear este).
3. Pruebas: mock del SDK para los estados/errores; E2E del intercambio de código
   en sandbox; regresión del signup de TuBot y del flujo de consola (comparten
   backend).

OPERATIVO DEL DUEÑO (prerequisito Meta — sin esto CUALQUIER código falla; dejarlo
impreso en el PR como checklist verificable):
· En developers.facebook.com, app "CONVERSIA" (2024917441656687):
  a) Agregar app.conversia.cl y conversia.cl a "Dominios permitidos del SDK de
     JavaScript" (Facebook Login for Business → Configuración) y a App Domains.
  b) Crear (o confirmar) la CONFIGURACIÓN de Embedded Signup para WhatsApp
     (Facebook Login for Business → Configurations) y copiar su config_id → env
     META_ES_CONFIG_ID_CONVERSIA.
  c) Verificar que la app está LIVE y el flujo de WhatsApp Embedded Signup
     habilitado (ya es Tech Provider por TuBot — debería estar).
· Env nuevas en Railway (api): META_ES_CONFIG_ID_CONVERSIA (+ appId ya existente).
ACEPTACIÓN: con el checklist Meta hecho, la cuenta de prueba del dueño conecta un
número de punta a punta DESDE /canales (popup → conectado → plantillas creándose
→ checklist marcado), y un fallo simulado muestra el mensaje accionable + abre el
asistente con contexto + crea la excepción en consola.
```

## BLOQUE B — "Asistente Conversia": implementación y asistencia unificadas in-app

```text
Contexto: pedido del dueño — un chat automático DENTRO de la plataforma que haga
la implementación y la asistencia general, lo más rápido y fluido posible. Base
existente: SupportWidget (F7, ya montado global en AppShell con ticket CV-XXXX y
continuidad WhatsApp) + agente de implementación + tools F8 + buildClientContext
(F10) + auto-QA (V2-6). Esto UNIFICA todo en un solo asistente omnipresente y
elimina la dependencia del número de prueba (P1) para la entrevista: la
entrevista corre AQUÍ, en el panel.

TAREAS
1. Evolucionar SupportWidget → "Asistente Conversia" (mismo componente, un solo
   chat, un solo historial):
   · El agente recibe SIEMPRE el contexto completo server-side: buildClientContext
     + pantalla actual (route) + estado del checklist + último error de canal si
     existe. Cero preguntas cuyas respuestas ya sabemos.
   · MODO IMPLEMENTACIÓN (automático mientras el checklist < 100%): el asistente
     LIDERA — saluda con el siguiente paso pendiente ("te falta conectar tu
     número, ¿lo hacemos ahora?"), y puede EJECUTAR configuración conversando:
     servicios, precios, horarios, datos del negocio vía las tools F8 con un
     ownerContext de SESIÓN WEB (el usuario autenticado owner/admin ES el dueño —
     nueva variante webOwnerContext, mismas validaciones y auditoría que la
     variante por teléfono; confirmación en 2 pasos para cambios con efecto).
     Tras cambios de configuración relevantes dispara el auto-QA (V2-6) y le
     cuenta el resultado ("probé a tu asistente con 6 escenarios: listo ✅").
   · MODO ASISTENCIA (checklist 100% o a demanda): el F7 actual (dudas, problemas,
     ticket CV-XXXX, escalar a humano, seguir por WhatsApp) — sin cambios de
     fondo, mismo hilo.
   · PROACTIVO acotado (sin ser plaga): si un paso clave falla o queda abandonado
     >2 min en la misma pantalla (p. ej. error de conexión del Bloque A), la
     burbuja pulsa UNA vez con el mensaje contextual ("vi que la conexión falló:
     te explico qué pasó"). Nunca más de 1 nudge por paso por sesión.
2. Entrada visible: además de la burbuja, ítem "Asistente" en el riel/tab bar
   "Más" y CTA en cada tarjeta del checklist ("hazlo conversando").
3. El asistente conoce y explica el MODELO DE COBRO (créditos/conversaciones,
   saldo actual vía wallet summary) — puede responder "¿cuánto me queda?" y
   ofrecer el pack correcto (link directo, jamás cobra él mismo).
4. Guardarraíles: tools de escritura solo con webOwnerContext (viewer/operador de
   soporte del cliente NO); todo auditado; prompt del asistente con las reglas de
   marca (no inventa precios de planes — getPlanes; deriva a humano al pedirlo).
5. Métricas: % de altas completadas 100% vía asistente, pasos resueltos
   conversando vs UI, tickets evitados.
ACEPTACIÓN (cuenta de prueba del dueño): entrar con checklist incompleto → el
asistente propone el siguiente paso; decirle "el corte vale 12.000 y no atendemos
lunes" → queda configurado (auditado) y el auto-QA corre; simular el error de
canal → el asistente lo explica y guía; con todo al 100% → modo asistencia normal
con ticket y continuidad WhatsApp. Un usuario viewer no puede configurar nada.
```

**Orden:** A y B en paralelo son viables (B no depende de A; el enlace "pedir
ayuda" de A se conecta al mergear ambos). Prioridad sugerida: A primero (destraba
el go-live del autoservicio), B inmediatamente después.
