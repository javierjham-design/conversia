# PROMPTS V2 — Conversia "se arma solo" + cobro por conversación (serie ejecutable)

Planner, 2026-10-14. Deriva de `docs/CONVERSIA_V2.md` (estructura aprobada del rediseño,
con la investigación de pricing/onboarding detrás). Calzado con el estado REAL del
repo a `origin/main 3ca33de`: E1–E3 en prod, R1/R2 y B1–B8 mergeados, decisiones del
dueño D1–D8 en `docs/CONVERSIA_ESTADO.md` (D1a servicio por créditos con free tier
por número; D3 WABAs de Conversia son NUESTRAS → pagamos Meta y recuperamos por
créditos; D5 máquina de alta; D8 identidad por marca/Origin). Rigen prompt maestro,
ESTADO y auditoría si chocan. **Un PR por etapa**, fila en la tabla de ESTADO, CI
verde, sin regresión TuBot ni del flujo Gestionado.

**Decisiones por defecto asumidas (del §6 de CONVERSIA_V2.md — ajustables por el
dueño en V2-0):** base $18.900/mes con 100 conversaciones · packs $44.900/400,
$84.900/1.000 · recarga suelta $12.900/100 (mismo precio unitario) · **30
conversaciones gratis sin tarjeta** al registro · Gestionado se mantiene como add-on
(conserva D5) · "Asistente Plus" (modelo premium = crédito x2) se construye con FLAG
APAGADO.

**Cómo conviven V1 y V2 (regla transversal):** todo V2 va detrás de
`features.v2SelfServe` en el plan / `settings.lifecycle.mode="v2"` de la org. Planes
`conversia_funcionando/gestionado` actuales = grandfathered intactos. En planes V2:
`conversationDebitsWallet=true` y `serviceDebitsWallet=false` — la CONVERSACIÓN
absorbe servicio+IA (D1a se cumple a través de la conversación; el free tier de
1.000/número sigue siendo NUESTRO ahorro de costo, no un débito al cliente). El bot
JAMÁS queda mudo por saldo (gracia + fallback), y ningún débito ocurre dos veces
(idempotencia por conversación/período ya garantizada por E3).

---

## PROMPT V2-0 — Cimientos: docs, flags, catálogo y corrección del free tier

```text
Contexto: arranque de la serie V2 (docs/PROMPTS_V2.md; estructura en
docs/CONVERSIA_V2.md). Nada visible para clientes todavía.
TAREAS
1. Commitear docs/CONVERSIA_V2.md, docs/CONVERSIA_AUTOMATICO.md y docs/PROMPTS_V2.md
   (están untracked) + agregar las filas V2-0…V2-9 a la tabla de CONVERSIA_ESTADO.md.
2. Flags y catálogo (sembrado INACTIVO, isPublic=false): plan "conversia_v2_base"
   ($18.900 CLP / USD 19, incluye 100 conversaciones/mes, features
   { v2SelfServe:true, conversationDebitsWallet:true, serviceDebitsWallet:false,
   aiPlus:false }), packs conversación 400/**$84.900**, 1.000/**$199.900**,
   recarga 100/**$21.900** (tipo nuevo "conversation" en MessagePackage, por marca
   como los sobres) — precios corregidos por el cálculo a máximo uso de
   CONVERSIA_V2.md §2.1 (los originales quedaban bajo el costo Meta). USD (D4):
   19 / 89 / 209 / 23.
3. CORRECCIÓN PENDIENTE del free tier (ya identificada en ESTADO): alinear el
   contador de mensajes de servicio gratis a la ZONA HORARIA DE LA WABA (no UTC) y
   contar por ENTREGADO (webhook delivered) con el contador Redis como estimación —
   exactamente como lo describe la "Nota crítica" de CONVERSIA_ESTADO.md.
4. Documentar en BILLING.md el modelo V2 (unidad conversación, rollover, gracia).
ACEPTACIÓN: seeds presentes e invisibles al público; typecheck/test verdes; free
tier contando en tz de la WABA con test de borde (23:59 vs 00:01 America/Santiago).
```

## PROMPT V2-1 — Crédito-conversación (wallet V2: débito, rollover, gracia, avisos)

```text
Contexto: la unidad de cobro V2 es 1 crédito = 1 conversación atendida por el bot
en la ventana de 24h. Base contable YA existente: countConversationOnce (E3,
idempotente por org+conversación+período) y la bolsa/ledger por marca.
TAREAS
1. Débito: para orgs con conversationDebitsWallet, al contar la conversación del
   período (countConversationOnce.counted=true) debitar 1 crédito de la bolsa
   (reason "conversation", refId=conversationId) — atómico e idempotente (si el
   débito falla por saldo, aplicar gracia, nunca doble débito). Conversaciones del
   MODO PRUEBA (web/número de prueba, V2-3/V2-4) NO debitan.
2. Acreditación mensual del plan (100) con ROLLOVER de 2 meses: asientos con
   expiresAt; consumir primero lo que expira antes; job de expiración con asiento
   "expiry" auditable. Créditos COMPRADOS expiran a 12 meses.
3. GRACIA al llegar a 0: hasta 20 conversaciones en negativo (se descuentan de la
   próxima acreditación/recarga). Bajo -20: el bot responde UNA frase de respaldo
   configurable + deriva a humano + marca la conversación "sin crédito" (no cuenta
   crédito). Avisos al dueño al 75% y 90% y al entrar en gracia — in_app + WhatsApp
   (catálogo de notificaciones) con CTA recargar.
4. "Asistente Plus" (flag aiPlus, APAGADO): si la org lo activa, el débito es 2 y
   el orquestador usa el modelo premium del catálogo — solo cableado + test.
5. Medidor: GET /billing/wallet/summary extendido para unidad conversación (usadas,
   restantes, en gracia, expiran este mes, proyección); UI de facturación y Hoy
   actualizadas (el anillo semántico ya existe — apuntarlo a conversaciones en V2).
6. GUARDRAIL ECONÓMICO (CONVERSIA_V2.md §2.1 — decide el margen): tope blando de
   12 respuestas del bot por conversación/día — al llegar, el agente recibe
   instrucción de modo conciso/resumen (nunca se calla; agrupa). Los prompts de
   los paquetes refuerzan respuestas breves (E4 ya garantiza 1 por turno).
   Telemetría: costo medio por conversación por tenant (ledger costUsd) con
   alerta a la cola de excepciones si supera $180 CLP.
ACEPTACIÓN (org de prueba V2): 3 conversaciones reales → 3 débitos exactamente; la
misma conversación con 30 mensajes = 1 débito; saldo 0 → gracia funciona y el bot
sigue; -21 → fallback + derivación; rollover y expiración con tests de fechas;
org TuBot y org conversia V1: CERO cambios (regresión).
```

## PROMPT V2-2 — Auto-recarga con tope (la tranquilidad del cliente)

```text
Contexto: patrón OpenAI/Lovable; advertencia: los 3 incidentes de auto-recarga de
Twilio — idempotencia y auditoría obligatorias.
TAREAS
1. Config por org (UI en facturación): auto-recarga ON/OFF, umbral (default: quedan
   20), pack a comprar (default 100/$12.900), TOPE de gasto mensual en recargas
   (obligatorio si ON; default $40.000). Tarjeta guardada Flow (ya existe) / Lemon
   para USD.
2. Motor en worker: al cruzar el umbral (post-débito V2-1), encolar recarga con
   clave idempotente (org+período+umbral+secuencia); verificar tope mensual ANTES
   de cobrar; cobro Flow → acreditar pack → notificación SIEMPRE (in_app + email +
   WhatsApp: "recargamos 100 conversaciones por $12.900; llevas $25.800 de
   $40.000 de tu tope"). Tope alcanzado → avisar y NO cobrar (la gracia de V2-1
   amortigua).
3. Reintentos de cobro fallido con backoff (máx 3) y alerta a la cola de
   excepciones (V2-8). Todo asiento de recarga referencia el paymentId (concilia
   con webhook como F9).
4. Auditoría completa + pantalla "historial de recargas".
ACEPTACIÓN: simular caída de saldo → UNA sola recarga aunque el evento se procese
dos veces; tope mensual respetado al peso; webhook duplicado de Flow no acredita
doble; OFF por defecto hasta que el cliente lo active con tarjeta válida.
```

## PROMPT V2-3 — Landing generador + simulador web (wow sin cuenta)

```text
Contexto: patrón Durable/Lovable/Chatbase (CONVERSIA_V2.md §1 pasos 1–4). El
producto en la portada; registro para GUARDAR.
TAREAS
1. Ruta pública /crear (y bloque embebible para la landing conversia.cl): chips de
   rubro (catálogo olas activas) + nombre del negocio + URL web/Instagram opcional.
2. DRAFT efímero server-side (sin crear Organization): tabla draft_sessions (token,
   rubro, nombre, scrape, config generada, TTL 72h, ipHash) — el scrape usa la
   lógica de leerWeb (servicios/precios/horarios si los hay; si no, demo del
   paquete). Rate limit por IP + turnstile suave. PROHIBIDO tocar tablas de tenant.
3. Construcción narrada (SSE): "Leyendo tu Instagram… cargando servicios…
   configurando agenda…" con pasos reales.
4. SIMULADOR jugable (UI WhatsApp-like con la piel Nocturna): chat contra el
   orquestador en modo sandbox (prompt del paquete + datos del draft, tools de
   lectura simuladas, SIN canal real, modelo económico, tope de 15 mensajes por
   draft). Marca de agua "Demo — crea tu cuenta para guardarlo".
5. Registro → MATERIALIZAR: crear la org V2 (brand conversia, país→acento, estado
   free_trial con 30 conversaciones de regalo SIN tarjeta) instalando el paquete +
   lo scrapeado; el usuario entra y SU bot ya está (cero empty state). El draft se
   destruye.
6. Instrumentar el funnel (events): draft_creado, simulador_primer_mensaje,
   registro, materializado.
ACEPTACIÓN: de incógnito, crear "Barbería Prueba" con un Instagram real → simular
una reserva en el chat → registrarse → el panel muestra el bot con los servicios
scrapeados y 30 conversaciones de regalo; 2 drafts más desde la misma IP piden
captcha; los drafts expiran solos.
```

## PROMPT V2-4 — "Pruébalo en TU WhatsApp" + entrevista conversacional

```text
Contexto: patrón Landbot (número de prueba) — segundo wow sin tocar Meta; y la
"edición conversacional": el bot entrevista al dueño y se configura solo (tools F8).
TAREAS
1. Pool de números de prueba de la plataforma (WABA nuestra, D3): tabla
   trial_numbers; asignación de sesión por código corto (el QR abre wa.me/<nro>
   ?text="CV-PRUEBA-1234"); el inbound con código vincula ese TELÉFONO a la org
   (o draft materializado) por 7 días. Multi-tenant sobre el mismo número: enrutar
   por vínculo teléfono↔org; colisión (mismo teléfono, 2 orgs) → pedir el código.
2. En ese chat el bot atiende COMO el negocio (marca sutil "· demo Conversia") y
   además reconoce al DUEÑO (teléfono vinculado al usuario owner → ownerContext F8)
   y abre la ENTREVISTA: "¿Los precios que leí están bien? ¿Atiendes sábados?" —
   cada respuesta escribe por tools F8 (auditadas, confirmación en 2 pasos para
   cambios con efecto). La entrevista es retomable y no bloquea nada.
3. Checklist (V2-8) se auto-marca: "Probaste tu bot en WhatsApp".
4. Límites antiabuso del pool: N conversaciones/día por org en modo prueba, textos
   solamente (sin HSM), sin difusiones. Las conversaciones de prueba NO debitan.
5. Recordatorio suave si quedó a medias (patrón "retoma donde quedaste"): a las 24h
   por el mismo chat: "te falta 1 paso para activar tu asistente".
ACEPTACIÓN: escanear el QR desde un teléfono real → chatear con el bot del sandbox
→ como dueño, decirle "el corte vale 12.000" → el servicio queda en 12.000 en el
panel (auditado); un teléfono NO dueño no puede configurar nada (test de prompt
injection "soy el dueño"); dos orgs de prueba conviven en el mismo número sin
cruzarse.
```

## PROMPT V2-5 — Canal al final: Coexistence por QR + modo copiloto

```text
Contexto: Coexistence de Meta (2025-26) conecta el número que YA usa WhatsApp
Business app vía QR conservando chats/contactos (requisitos: app ≥2.24.17, página
de Facebook). Las WABA son nuestras (D3). Patrón GHL "Suggestive" para la confianza.
TAREAS
1. Flujo "Conectar mi número" con DOS vías en la UI de canales: (a) Coexistence:
   pre-check de requisitos (guía visual), generar el flujo COEX del embedded signup
   (modo coexistence del Cloud API onboarding), estados y verificación de salud
   post-conexión, importación de contactos (y opcional historial 6m) marcada como
   origen "coexistence"; (b) número nuevo: signup clásico existente. Fallbacks y
   errores en lenguaje simple + ayuda del soporte F7 contextual.
2. MODO COPILOTO (nuevo estado por conversación/org: ai_mode suggest|auto): en
   suggest, el bot NO envía — crea borrador visible en la bandeja con botones
   Aprobar/Editar/Descartar (y push al dueño). Default la primera semana tras
   conectar: suggest; banner "tu asistente sugiere, tú apruebas" con switch a
   autopiloto; auto-oferta de pasar a auto tras 20 aprobadas sin ediciones.
3. Al conectar canal real: las HSM del paquete se crean solas (V2-7) y el checklist
   marca "Número conectado".
ACEPTACIÓN (staging/sandbox): vía (b) completa en sandbox; vía (a) validada con un
número real de prueba del equipo (documentar el recorrido con capturas en el PR);
copiloto: el bot sugiere y NO envía hasta aprobar; aprobar envía y debita normal;
cambio a autopiloto persiste; TuBot sin cambios.
```

## PROMPT V2-6 — Auto-QA, auto-publicación y canario por tenant

```text
Contexto: nadie del equipo revisa altas; la calidad la garantiza una batería
automática (CONVERSIA_V2.md §1 paso 9). Base: endpoint de test del agente (R2),
simulador, reliability-monitor.
TAREAS
1. qaScenarios por vertical en vertical_templates (sembrar 6–10 por rubro de ola
   activa): guion de usuario + aserciones (agendó con el servicio/duración
   correctos, NO inventó precios (regla 3), derivó urgencia a humano, respetó
   horario, un solo mensaje por turno).
2. Runner: corre la batería contra el agente BORRADOR de la org (modelo económico,
   contexto sandbox); score por escenario; verde total → PUBLICAR automático
   (versión + auditoría "auto-qa"); fallo → UNA autocorrección acotada (feedback
   del fallo al prompt vía plantilla de corrección, re-run) → persiste el fallo →
   NO publica + alerta a la cola (V2-8) + el checklist lo muestra honesto
   ("estamos afinando tu asistente").
3. Gatillos del runner: materialización (V2-3), cambios de la entrevista (V2-4,
   debounced), edición en consola (opcional "publicar con QA").
4. CANARIO continuo: semanal por tenant activo (2 escenarios aleatorios contra la
   versión publicada); dos fallos seguidos → bajar la org a COPILOTO
   automáticamente + alerta (kill-switch de calidad, nunca apagar el bot).
5. Costos del QA: modelo económico, presupuesto diario de plataforma, trazas
   ai_requests origen "auto-qa" (excluidas del costo del tenant).
ACEPTACIÓN: org nueva de barbería pasa QA y su agente queda PUBLICADO sin humano;
romper el prompt a propósito (precio inventado) → autocorrección o alerta, jamás
publica roto; canario degrada a copiloto tras 2 fallos y lo registra.
```

## PROMPT V2-7 — Plantillas HSM creadas por API

```text
Contexto: hoy la guía sugiere plantillas y el cliente las crea en Meta a mano. Las
WABA son nuestras (D3) → podemos crearlas por Graph API (message_templates).
TAREAS: al conectar canal (V2-5), crear automáticamente las plantillas del paquete
vertical (template-guide ya las define con vocabulario aplicado): POST por API con
idempotencia por (waba, nombre, idioma); monitoreo del estado por webhook
(message_template_status_update ya llega) con UI de estado (pendiente/aprobada/
rechazada + razón); rechazada → 1 reintento con ajuste automático del texto
(variantes pre-aprobadas en la plantilla del paquete) → persiste → alerta cola.
Recordatorios/flows que dependan de una HSM se activan solos al aprobarse.
ACEPTACIÓN: en una WABA de prueba, conectar → plantillas del rubro creadas y
estados reflejados sin tocar Business Manager; rechazo simulado ejecuta la
variante; nada se envía con plantillas no aprobadas (compuertas existentes).
```

## PROMPT V2-8 — Checklist de activación + cola de excepciones

```text
Contexto: patrón Shopify (checklist auto-completable) + operación por excepción
(CONVERSIA_V2.md §3). El semáforo de implementación (F10) ya existe server-side.
TAREAS
1. Panel del cliente: tarjeta "Activa tu asistente" (5 ítems, primero pre-marcado:
   Bot creado ✓ · Pruébalo en tu WhatsApp · Ajusta servicios y precios · Conecta tu
   número · Comparte tu link) — event-driven sobre los pasos reales (sin marcar a
   mano), con CTA directo por ítem y celebración al completar. Desaparece al 100%.
2. Consola: el home del admin/operador pasa a COLA DE EXCEPCIONES — tabla
   exceptions (tipo: qa_failed, canario_degradado, saldo_gracia_sin_recarga,
   recarga_fallida, numero_salud, hsm_rechazada, coexistence_error,
   margen_negativo, abandono_alta>48h) con severidad, org, asignación a operador,
   estado y resolución; generadas por los módulos V2-1…V2-7 + margins existente.
   Badge con pendientes; la cartera/fichas quedan a un click (no desaparecen).
3. Notificaciones de cola a los operadores (in_app/email) con digest diario.
ACEPTACIÓN: completar el alta sandbox marca los 5 ítems solos; forzar un fallo de
QA y una recarga fallida crea 2 excepciones visibles, asignables y resolubles; un
tenant sano NO aparece en ninguna lista de trabajo.
```

## PROMPT V2-9 — Go-live V2: migración, grandfathering y funnel

```text
Contexto: encender V2 sin romper a nadie (anti-Cursor). D5/Gestionado quedan para
el add-on humano; D8 identidades por marca ya operan.
TAREAS
1. Switch por marca: brandConfig.selfServeV2=true para conversia → /registro y
   /crear usan el flujo V2 (30 gratis, sin tarjeta, sin wizard de consola); el alta
   Gestionado (wizard F10 + D5 setup/entrega) sigue disponible desde la consola y
   como add-on comprable ("que el equipo lo deje listo por $149.900+").
2. Grandfathering: orgs conversia V1 existentes intactas; banner opt-in "nuevo
   plan por conversaciones" con SIMULADOR personal ("con tu uso de sep-oct habrías
   pagado $X vs $Y actual") usando sus usage_events reales; migración 1-click
   (cambia plan al siguiente ciclo, créditos de cortesía del primer mes). Sin
   fecha forzada de migración.
3. Fin del free_trial (30 conv): al consumirse, pedir activación (base $18.900 o
   pack) con resumen de valor ("tu bot atendió 30 conversaciones y agendó N
   horas"); 7 días de gracia en copiloto antes de pausar (los datos JAMÁS se
   purgan por esto; retention-purge sigue excluyendo conversia como B6).
4. Textos/los precios públicos (web pricing + getPlanes del bot comercial) al
   modelo V2; COSTOS §0 marcado como superado por CONVERSIA_V2.md §2.
5. KPIs del funnel (CONVERSIA_V2.md §4) en un dashboard simple de consola.
ACEPTACIÓN: registro nuevo recorre V2 completo de punta a punta sin intervención
(draft→simulador→registro→prueba WhatsApp→entrevista→QA publica→Coexistence→
30 gratis→activación con pago→auto-recarga); una org V1 no nota NADA salvo el
banner; Gestionado se puede comprar y dispara el flujo D5; TuBot intacto.
```

---

## Orden y dependencias
V2-0 → V2-1 → V2-2 (dinero primero, probado en una org interna) · V2-3 → V2-4
(wow público; V2-4 depende del pool de número — gestionar el número de prueba con
el dueño) · V2-5 → V2-7 (canal) · V2-6 tras V2-3 (usa el sandbox) · V2-8 cuando
existan productores de excepciones · V2-9 AL FINAL con OK explícito del dueño para
encender el switch. Modelos sugeridos por sesión: dinero/seguridad (V2-1, V2-2,
V2-9) con el modelo top; resto estándar.

## Operativo del dueño (paralelo)
Número(s) del pool de prueba (V2-4) · validar Coexistence con un número real del
equipo (V2-5) · producto/variantId de Lemon para packs USD (D4) · textos de la
landing/pricing · decidir fecha de encendido del switch (V2-9).
