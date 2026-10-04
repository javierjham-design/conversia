# PROMPT AJUSTES R2 — Configurador COMPLETO de agentes IA en la consola Conversia (paridad TuBot)

Pedido del dueño (2026-10-04, tras revisar la consola): en la ficha del tenant la
tarjeta "Agentes de IA" solo muestra un resumen y un editor de texto. El equipo
Conversia (operador/super admin) necesita, DESDE LA FICHA DEL TENANT, el
configurador y gestor completo de agentes — exactamente tan completo como el de
TuBot — para ajustar TODO el entorno del agente: prompt, herramientas,
agendamiento, conocimiento, links/cobros, pruebas y publicación. Rigen el prompt
maestro y la auditoría si chocan. Un PR; CI verde.

REFERENCIA DE PARIDAD (fuente de verdad funcional): el editor de TuBot
`apps/web/src/app/(app)/agents/[id]/page.tsx` (~1.100 líneas) + su API
`apps/api/src/agents/agents.controller.ts` (meta/tools, meta/knowledge, list,
create, assignable, :id, :id/test, :id/publish, :id/active, delete). La paridad es
FUNCIONAL: misma capacidad, piel del design system Conversia.

PRINCIPIOS (no negociables)
· El CLIENTE Conversia sigue SIN configurar agentes (decisión de producto): su
  panel mantiene "Mi asistente" solo-lectura + "solicitar cambio". El configurador
  completo vive ÚNICAMENTE en la consola (roles super admin y OPERADOR).
· Cero duplicación de lógica de negocio: la edición/publicación/prueba reusa los
  servicios existentes de agents (withTenant sobre la org objetivo). El frontend:
  o se extrae el editor a un paquete compartido sin estilos acoplados
  (packages/agent-editor con slots de UI) consumido por apps/web y conversia-web,
  o se porta nativo al design system Conversia — a criterio del implementador,
  PERO con la checklist de paridad completa y SIN regresión alguna en TuBot.
· Toda acción queda en el audit log de plataforma (quién, qué org, qué agente,
  qué cambió — diff resumido), como el resto de F10.
· Límites y costos del tenant aplican también desde la consola (modelo permitido,
  tope de tokens); el override de modelo por agente del super admin existente se
  integra aquí, no se duplica.

TAREA 1 — API de plataforma por organización (espejo 1:1 del controller de agents)
Nuevas rutas bajo /platform/organizations/:id/agents con guard de plataforma
(super_admin y operador), todas resolviendo withTenant(orgId) y auditadas:
  GET    …/meta/tools        (tools disponibles; respetar módulos/vertical de la org)
  GET    …/meta/knowledge    (fuentes de conocimiento de la org)
  GET    …                   (lista con versión actual, borrador, modelo, costos mes)
  POST   …                   (crear agente)
  GET    …/:agentId          (detalle completo: borrador + publicada + historial)
  POST   …/:agentId/test     (PROBADOR: ejecuta con la config pasada SIN publicar;
                              marca origen "console-test" en ai_requests para trazas)
  POST   …/:agentId/publish  (borrador → publicada)
  POST   …/:agentId/active   (activarlo/asignarlo como default de canal)
  DELETE …/:agentId          (con confirmación; soft-delete como TuBot)
Reusar los endpoints existentes GET organizations/:id/agents/:agentId y el POST de
override de modelo integrándolos a este set (sin romper sus consumidores).

TAREA 2 — Editor completo en la consola (conversia-web /admin)
Ruta: /admin/organizations/[id]/agents (lista) y /admin/organizations/[id]/agents/
[agentId] (editor). Desde la tarjeta "Agentes de IA" de la ficha: botón "Abrir
configurador" (por agente) y "Nuevo agente". CHECKLIST DE PARIDAD (todo lo del
editor TuBot, verificado contra su código):
  1. Identidad: emoji, nombre, tipo/kind, descripción.
  2. Prompt del sistema: editor grande con contador aproximado de tokens,
     VARIABLES insertables con un clic ({{organization.name}}, {{contact.firstName}},
     {{clinic.city}}, …la lista real del sistema) y detección de variables usadas.
  3. Biblioteca de plantillas de prompt (PromptTemplateMenu): insertar plantillas
     del tenant/globales; en Conversia incluir las plantillas del PAQUETE VERTICAL
     instalado como primeras opciones.
  4. Modelo (catálogo permitido + override del super admin), maxTokens,
     maxToolRounds, idioma.
  5. ACCIONES/HERRAMIENTAS habilitadas (las ~27 tools: agendar, precios,
     disponibilidad, links de pago, transferencias, buscar conocimiento, etc.) con
     el campo por acción "¿Cuándo y cómo debe ejecutarse esta acción?" —
     exactamente como TuBot.
  6. AGENDAMIENTO: profesionales/recursos habilitados para este agente
     (schedulingProfs) y duración de cita por defecto (apptDuration).
  7. CONOCIMIENTO: fuentes (knowledgeSources) seleccionables.
  8. Transferencias: a qué agentes puede derivar (transferTo) y a humano.
  9. PROBADOR EN VIVO (AgentTester): conversación de prueba con la configuración
     ACTUAL del formulario (sin publicar), mostrando tools ejecutadas y costo.
  10. Ciclo borrador → "Publicar" (crea versión publicada; el borrador persiste
      entre sesiones); historial de versiones con quién/cuándo y el prompt de cada
      una (diff simple basta).
  11. Activar/asignar: agente activo y default por canal (POST …/active).
  12. Eliminar con confirmación. Aviso de cambios sin guardar al salir.
Estados vacíos bien resueltos (org sin conocimiento, sin profesionales, sin canal).
Diseño: design system Conversia (tokens/acento; nada de Tailwind de apps/web).

TAREA 3 — Integración con el flujo llave en mano
· La tarjeta "Agentes de IA" de la ficha pasa a resumen + enlaces al configurador
  (se elimina el editor de texto suelto actual).
· El paso "Agentes configurados (prompts)" del checklist de implementación se
  marca done cuando el agente tiene versión PUBLICADA (no solo borrador), y el
  wizard de alta enlaza directo al configurador.
· El borrador que instala el paquete vertical (A3 de PROMPT_AJUSTES_R1) debe abrir
  precargado en este editor.
· buildClientContext (soporte F7/F10) incluye nombre, modelo y versión publicada
  del agente — verificar que siga correcto tras estos cambios.

TAREA 4 — Seguridad y pruebas
· Permisos: operador y super admin SÍ; cualquier token de tenant NO (403) — test.
· RLS/withTenant: un operador editando la org A jamás toca datos de la org B — test
  cruzado.
· El probador respeta tope de tokens diario del tenant y registra costo con origen
  console-test — test.
· Auditoría: crear/editar/publicar/activar/borrar y cada test quedan en audit log
  — test.
· Regresión TuBot: el editor de apps/web intacto (typecheck + smoke de sus rutas).

CRITERIO DE ACEPTACIÓN (con la org sandbox Barbería Demo Sandbox):
desde /admin/organizations/:id, abrir el configurador del agente "Recepción",
ver el borrador del paquete barbería precargado, habilitar la tool de agendamiento
con sus profesionales (los de A2/R1) y duración 30 min, insertar una variable y una
plantilla del vertical, PROBARLO en vivo (responde y simula agendar sin publicar),
PUBLICAR, activarlo como default, y que el checklist de implementación marque
"Agentes configurados". Todo auditado; TuBot sin cambios.
