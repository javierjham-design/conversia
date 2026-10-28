# PROMPT DE DESARROLLO — Copiloto de montaje de Conversia (de la cuenta nueva al bot conectado y pagado)

**Para el desarrollador (Claude Code en VS Code, con agentes).** Fecha: 27-oct-2026.

## Objetivo de negocio

Hoy el "Asistente Conversia" es un chat en la esquina inferior derecha que responde dudas.
El dueño quiere un **copiloto de montaje**: un personaje visible y protagonista que, desde el
primer minuto, **lleva de la mano** al cliente y **hace el trabajo por él**. Abre las
pantallas, configura el negocio, arma los agentes de IA que el cliente necesita, lo guía en
la conexión de WhatsApp, prueba el bot y **lo lleva al pago**. La meta medible es que un
dueño nuevo, sin ayuda humana, tenga el **bot conectado, publicado y pagado en menos de 10
minutos**. Esto alimenta la próxima campaña en Meta Ads, así que la conversión del montaje
es la métrica que importa.

Trabaja por etapas, en orden, con un PR por etapa. **TuBot está en producción y no se toca
su funcionamiento.** El asistente ya está gateado a la marca `conversia`; mantenlo así.

---

## Hallazgos de la auditoría (26/27-oct): qué impide hoy llegar al bot activo

Antes de construir el copiloto hay que tapar estos huecos. Un copiloto que guía a un callejón
sin salida no sirve.

1. **El bot nunca se publica en el flujo del cliente.** El paquete vertical instala los
   agentes y workflows **como borrador** (`packages/database/src/vertical-loaders.ts:241`,
   `publish:false`). `runQaBattery` (`apps/api/src/agents/agent-qa.ts:75`) solo se expone
   al super admin, y el asistente lo llama con `autoPublish:false`
   (`assistant.service.ts`). Resultado: `/inicio` muestra para siempre "Asistente en
   preparación" (`inicio/page.tsx:121-129`), porque exige agente publicado y canal activo.
2. **El canal se crea sin agente asignado.** `channels.controller.ts:672` guarda
   `defaultAgentId: input.defaultAgentId ?? null` y `canales/page.tsx` nunca lo envía.
   Aunque el número quede conectado, nadie responde en él.
3. **El cliente no puede pagar desde conversia-web.**
   - Los URLs de éxito/cancelación del checkout y el retorno del registro de tarjeta
     apuntan a `/billing` (`billing.controller.ts:296` y `:468`), una ruta que **no existe**
     en conversia-web (sí en TuBot).
   - conversia-web nunca llama `subscription/start` ni `subscription/confirm-card`, así que
     el paso "método de pago" del checklist no se puede completar desde el panel.
4. **Dos checklists distintos.** `buildContext` del asistente tiene 4 pasos y considera
   "agente" listo con solo existir. `GET /onboarding` (`onboarding.controller.ts:50-104`)
   tiene 7 pasos, con CTAs a rutas de TuBot (`/channels`, `/billing`, `/agents`,
   `/settings/users`) que no existen en conversia-web.
5. **Lo que el cliente escribió en `/crear` se pierde.** De la DraftSession solo se usa el
   `vertical`. El nombre del negocio, los datos del scrape web y el prompt del borrador no
   se aplican a la organización al registrarse (`auth.service.ts:57-261`).
6. **No hay editor de agentes en el panel del cliente.** `agent-templates.ts`,
   `agent-actions.ts` y `agent-help.ts` solo los usa la consola de super admin.
7. **El asistente no puede actuar sobre la interfaz.** La respuesta es
   `{reply, wrote?, qa?}`. No hay campo de acciones ni navegación, el markdown se aplana a
   texto y los chips sugeridos están fijos en el código.
8. **El modelo es chico para un agente que ejecuta.** El default es `gpt-4o-mini`, con un
   máximo de 4 rondas de herramientas y `maxTokens: 700`.

---

## ETAPA 0 — Que el camino hasta "bot activo y pagado" exista (prioridad 1) — ✅ #550 + #560

- **Checklist único de montaje** como fuente de verdad, en un servicio de la API reutilizado
  por `/assistant/context`, `/onboarding` (cuando la marca es conversia) y la UI. Los pasos,
  con su condición real de "hecho":
  1. Datos del negocio (nombre, rubro, dirección/comuna, horario de atención).
  2. Servicios con precio y duración.
  3. Agenda: al menos un profesional con horario (si el rubro agenda citas).
  4. Asistente de IA personalizado **y publicado** (no basta con que exista).
  5. WhatsApp conectado **y con el agente asignado** al canal.
  6. Prueba real: el bot respondió al menos un mensaje de prueba.
  7. Plan activado / método de pago cargado.
  8. Opcionales que no bloquean el 100%: mini-sitio, invitar al equipo, instalar la app
     (PWA), activar notificaciones, verificar correo.

  Cada paso trae `href` a una ruta **que exista en conversia-web**. Agrega un test que
  recorra todos los `href` contra las rutas reales de la app.
- **Publicación en el flujo del cliente**: endpoint autenticado para owner/admin que corre
  `runQaBattery` con `autoPublish:true` sobre el agente del cliente. Si la batería pasa,
  publica; si no, devuelve qué escenario falló en lenguaje simple. Auditado.
- **Asignar el agente al canal**: al conectar WhatsApp (estándar o coexistencia), si la org
  tiene un agente publicado y el canal no tiene `defaultAgentId`, se asigna solo. Si el
  agente se publica después, también se asigna a los canales que no tengan uno. Es
  idempotente y tiene tests.
- **Cobro en conversia-web**: rutas de retorno propias de la marca (p. ej.
  `/cobros?pago=ok|cancelado`), elegidas por la marca de la org en la API, sin romper las de
  TuBot. Flujo de registro de tarjeta con Flow (`subscription/start` → retorno →
  `confirm-card`) disponible en `/cobros`. Prueba e2e del checkout en modo mock.
- **Aplicar el borrador de `/crear` al registrarse**: nombre del negocio, datos del scrape
  (dirección, horario y servicios si se detectaron) y el prompt del borrador al agente
  instalado. Sin pisar lo que el vertical ya trae si el scrape no encontró el dato.

## ETAPA 1 — Protocolo de acciones: el copiloto actúa, no solo conversa — ✅ #561

- La respuesta de `POST /assistant/message` agrega `actions: Action[]`, tipadas en
  `@conversia/types` y validadas con zod. Tipos mínimos:
  - `navigate {to}`: lleva al cliente a una pantalla del panel. Se ejecuta automático.
  - `highlight {target, text}`: resalta un elemento (coach mark) con un globo explicativo.
    Los elementos clave llevan un `data-copilot="<id>"` estable.
  - `button {label, kind, payload}`: botón dentro del chat para lo que **requiere un clic del
    usuario**: conectar WhatsApp (el popup de Meta lo bloquea el navegador si no viene de un
    clic), pagar, abrir un enlace externo.
  - `checklist_refresh`: la UI recarga el avance.
  - `celebrate {step}`: animación corta al completar un paso.
- Reglas de autonomía:
  - Lecturas, navegación y resaltados: automáticos.
  - Cambios de configuración: el copiloto propone el cambio concreto y lo aplica con **un**
    "sí" del dueño. Si el dueño dice "arma todo tú", puede aplicar en lote mostrando un
    resumen al final.
  - Pagos y conexión con Meta: **siempre** con un clic del dueño en un botón. El copiloto
    nunca cobra ni abre el popup por su cuenta.
- **Herramientas nuevas del copiloto** (zod server-side, permisos y tenant en el contexto,
  auditadas; solo owner/admin las de escritura):
  - Negocio: completar datos del negocio y horario de atención.
  - Agenda: crear/editar profesionales con su horario semanal, ajustar la configuración de
    agenda (intervalo, anticipación). Hoy el prompt manda a "Agenda → Configurar"; ahora lo
    hace él, confirmando.
  - Agentes (el copiloto **nunca** cambia el modelo de IA: todo agente nace con
    gpt-4o-mini y solo el super admin activa uno más avanzado, con el cliente avisado; ver
    `docs/MODELO_COBRO_CREDITOS_IA.md` §4): listar plantillas del rubro (`/public/verticals`), crear el agente desde
    plantilla o desde lo que cuente el dueño, ajustar tono, reglas y preguntas frecuentes
    (`PUT /agents/:id/draft`), **probarlo** (`POST /agents/:id/test`) mostrando la
    conversación de prueba en el chat, y **publicarlo** con el endpoint de la Etapa 0. Puede
    crear más de un agente si el negocio lo necesita (p. ej. recepción y ventas).
  - WhatsApp: diagnosticar el estado (`GET /channels`, último error de canal), recomendar
    coexistencia o número nuevo según lo que diga el dueño, y entregar el botón de conexión
    con el modo correcto ya elegido.
  - Prueba real: enviar un mensaje de prueba al número del dueño, o pedirle que escriba al
    bot desde otro teléfono, y confirmar que respondió.
  - Cobro: estado del plan y saldo, botón de activar plan o recargar.
  - Mini-sitio: activarlo con los datos ya cargados.
- **Modelo**: variable nueva `ASSISTANT_MODEL`, separada de `AI_DEFAULT_MODEL`, con un modelo
  capaz de agente con herramientas (recomendado: Claude Sonnet vigente). Subir el límite a
  ~8 rondas y ~1.200 tokens de salida. Registrar el costo por sesión de montaje (tabla de
  precios en `packages/agents/src/pricing.ts`). Mantener el fallback actual si el proveedor
  cae.
- El markdown simple (negritas, listas, enlaces internos) se renderiza en vez de aplanarse.

## ETAPA 2 — Experiencia: un copiloto protagonista, no una burbuja olvidada — ✅ #562

- **Personaje**: un avatar ilustrado propio en SVG inline (sin assets externos, por la CSP),
  con estados: saludando, pensando, hablando, celebrando, preocupado (cuando hay un error).
  Nombre por defecto: **"Convi"**, configurable en una constante de marca (el dueño puede
  cambiarlo). Usa los tokens de color de `globals.css` y funciona en tema claro y oscuro.
- **Modo montaje** (checklist < 100%):
  - En la primera entrada después del registro, el copiloto **se abre solo** como panel
    lateral acoplado en escritorio y como hoja inferior en móvil (no como globo flotante).
    Saluda por el nombre del negocio y propone empezar.
  - Barra de progreso del montaje siempre visible en el panel ("Paso 3 de 7 · faltan ~4
    min"), con los pasos clicables.
  - Al navegar, el copiloto acompaña: comenta la pantalla en la que está el cliente y
    resalta qué tocar.
  - Si el cliente lo cierra, queda un acceso visible con el avatar y el progreso (no un ícono
    genérico), y vuelve a ofrecer ayuda en momentos clave: al volver al panel, si una pantalla
    queda quieta más de ~60 s en un paso pendiente, o ante un error de conexión.
- **Modo asistencia** (100%): pasa a ser un acceso discreto con el avatar, y avisa
  proactivamente de lo importante: saldo bajo, canal caído, citas por confirmar.
- Chips sugeridos **dinámicos**, según el paso pendiente (no fijos en el código).
- Accesible: navegable con teclado, `aria-live` para los mensajes, respeta
  `prefers-reduced-motion` en las animaciones del avatar.

## ETAPA 3 — Inducir al pago y explicar los detalles de Meta — ✅ #563

- **Momentos de pago** dentro del guion, nunca agresivos pero siempre presentes:
  - Al terminar el montaje: "Tu bot ya está atendiendo. Tienes tus créditos de prueba;
    activa el plan para que no se corte", con el precio y los créditos leídos del catálogo.
    **La unidad de cobro pasa a ser Créditos IA** (ver `docs/MODELO_COBRO_CREDITOS_IA.md`):
    el copiloto habla de créditos y siempre traduce a "≈ N conversaciones" con el estimador.
  - Al llegar a ~70% y ~90% del saldo de prueba, y al agotarlo.
  - Al ver valor: después de la primera cita agendada o la primera conversación atendida por
    el bot, mostrar lo que logró y el botón de activar.
  - Precios siempre desde el catálogo (`ofrecerRecarga`, `/billing/v2`), jamás inventados.
- **Detalles de Meta que el copiloto debe explicar en el momento justo**, sin jerga:
  - Coexistencia: qué es, que sigue usando su app y sus chats, que necesita la app WhatsApp
    Business actualizada y con uso reciente, y qué hacer si Meta dice que el número no es
    elegible.
  - Número nuevo: que necesita un número que no esté en WhatsApp, el código por SMS o
    llamada, y la verificación del negocio si Meta la pide (ya existe copy y escalamiento).
  - **Método de pago en Meta** (los mensajes de WhatsApp los cobra Meta). **Decisión del
    dueño (27-oct): cada cliente paga a Meta con su tarjeta**; la rama activa es "sin línea
    de crédito" y es la que debe quedar pulida. La otra queda lista detrás de la
    configuración por si a futuro se usa un Solution Partner
    (`apps/api/src/channels/whatsapp-onboard.ts:144-179`, `META_EXTENDED_CREDIT_ID`):
    - **Con línea de crédito compartida**: el copiloto le dice que no necesita agregar
      tarjeta en Meta y que todo se paga en Conversia.
    - **Sin línea de crédito**: el copiloto lo guía paso a paso a agregar su tarjeta en
      Meta (Business Manager → Facturación y pagos → método de pago de la cuenta de
      WhatsApp), con un botón que abre esa página y la verificación posterior de que quedó
      cargado si la API de Meta lo permite. Explica la diferencia: Conversia cobra el
      plan; Meta cobra aparte ciertos mensajes.
    Deja en `docs/AJUSTES_RESULTADOS.md` cuál rama queda activa hoy en producción.

## ETAPA 4 — Medición y pruebas

- **Eventos del embudo de montaje** por organización (tabla propia o `IntegrationEvent`):
  cuenta creada, cada paso completado, bot publicado, canal conectado, primer mensaje
  respondido, plan activado, con marca de tiempo. Panel simple en el super admin con el
  embudo y el tiempo medio hasta "bot activo".
- **Señales para Meta Ads**: dejar preparado (con flag apagado) el envío por API de
  Conversiones de `CompleteRegistration` (cuenta creada), un evento personalizado de bot
  activo y `Purchase` (plan activado, con valor en CLP). La campaña se va a optimizar con
  estos eventos.
- **Playwright "dueño nuevo desde cero"**: registro → copiloto abierto solo → datos del
  negocio → servicios → profesional y horario → agente creado, probado y publicado → conexión
  de WhatsApp con el popup mockeado (FINISH y FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING) →
  canal con agente asignado → checkout mock → "Asistente activo" en `/inicio`. Que corra en
  escritorio y en móvil y mida el tiempo total.
- Tests unitarios de cada herramienta nueva (permisos, tenant, validación) y del protocolo
  de acciones.

## Cierre

- typecheck + tests + build + Playwright en verde. Un PR por etapa con evidencia (capturas o
  video del recorrido completo en móvil).
- Después de cada etapa, verificar que conversia-web quedó publicada con el sello de versión
  igual a `main` (autodeploy de #538).
- El orden de estas etapas, intercaladas con la auditoría y los Créditos IA, lo fija
  `docs/PLAN_EJECUCION_LANZAMIENTO.md`.
- Entregable: `docs/COPILOTO_RESULTADOS.md` con qué quedó por etapa, el tiempo medido del
  recorrido completo, la rama de pago en Meta activa y las decisiones que tomaste.

## Reglas duras

TuBot intacto · `organizationId` siempre del JWT, nunca del cliente ni del modelo · la IA
nunca escribe directo en la BD, solo vía herramientas validadas · el copiloto jamás cobra ni
abre el popup de Meta sin un clic del dueño · nada de precios, prompts ni datos de un cliente
en el código · prohibido marcar verde lo que un test o un navegador no vio funcionar.
