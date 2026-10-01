# AUDITORÍA DE LOS PROMPTS DE DESARROLLO CONVERSIA (E1–E5 · F1–F10 · auditoría pre-prod)

**Fecha:** 2026-10-01 · **Base de código:** main 9befbe6 · **Plan auditado:** docs/PROMPTS_CONVERSIA.md (versión integrada del 2026-10-01)

**Método:** 8 auditores independientes (coherencia de dependencias, modelo de dinero, seguridad/multitenancy, deriva temporal, brechas de flujo, y 3 lotes de verificación de referencias archivo:línea contra el código real), fusión de duplicados y verificación adversarial de cada hallazgo (refutadores con lentes de exactitud y materialidad). 84 agentes en total.

**Resultado:** 52 hallazgos confirmados (0 refutados): 3 BLOQUEANTES · 20 ALTOS · 22 MEDIOS · 7 BAJOS. Además, 79 verificaciones de que el resto del plan calza con el código (lista al final).

**Veredicto:** el plan es ejecutable y de muy buena factura, pero NO tal cual: los 3 bloqueantes tocan el mecanismo central de monetización de Conversia (H1, H2) y la seguridad del soporte (H3), y hay decisiones del dueño que deben cerrarse antes de F5. Ejecutar siempre vía **docs/PROMPT_MAESTRO_CONVERSIA.md**, cuyos ajustes por etapa incorporan todos los fixes de este informe.

## Índice por severidad

### BLOQUEANTE
- **H1** — El débito de créditos por mensajes de servicio en Conversia no lo construye ninguna etapa: los créditos vendidos nunca se agotan
- **H2** — walletWeights es UNA key global de platform_settings: sembrar 1/1/1/4 «para orgs brand=conversia» (F5 TAREA 3) cambiaría los débitos de todos los tenants TuBot
- **H3** — F7: el vínculo WhatsApp↔ticket por código CV-XXXX no autentica al remitente — fuga de contexto de soporte de otro cliente

### ALTO
- **H4** — El plan y sus documentos base están UNTRACKED: no existen en main ni en un clon limpio
- **H5** — El costo de Meta corre invisible desde hoy y el plan mantiene el ritmo de septiembre: la ventana «dos semanas de datos antes del cobro» ya no existe
- **H6** — Checklist del dueño con ítems vencidos: el aviso a clientes ya va tarde y la verificación de medios de pago por WABA es urgente HOY
- **H7** — E1 TAREA 4 redacta como futuro («cuando Meta publique…») una verificación que debe ejecutarse HOY contra el webhook real
- **H8** — E5 instalaría copys transitorios ya vencidos: wallet.empty promete una gratuidad que ya no existe y el bot comercial citaría «hasta el 30-09 son gratis» en presente
- **H9** — getPlanes devuelve solo planes isPublic=true: el agente comercial Conversia cotizaría los planes TuBot
- **H10** — F7 (WEBCHAT) pasa por el mismo agent-turn que el medidor/freno de WhatsApp y el plan no lo excluye; además el despacho de envío enruta por contact.phone, no por canal
- **H11** — Alta y activación del ciclo Conversia sin máquina de estados: el payment-link existente ACTIVA la suscripción al pagarse, F5 y F10 se contradicen sobre el gatillo, y el trial-lifecycle purgaría orgs vendidas en espera
- **H12** — Grandfathering: el modelo actual NO lo garantiza, y F5 lo exige «sin migración» cuando la versión mínima requiere DDL
- **H13** — Overage de conversaciones: E3 lo cuenta y su copy promete «se suma a tu factura», pero ninguna etapa lo factura
- **H14** — El tier gratis de Meta (1.000 mensajes de servicio/mes por número) no está modelado en ninguna etapa, pero la auditoría pre-prod lo exige y COSTOS calcula todo sobre él
- **H15** — Los reintentos que agrega N2 a la cola outbound son no-op (y el «no refund antes del throw» de la TAREA 4 deja una fuga de créditos)
- **H16** — F10: falta la tarea de enforcement RBAC default-deny — el token del operador hoy valdría para TODO /platform/*
- **H17** — MFA obligatorio del operador: el propio plan lo declara «bloqueante de auditoría» y F10 no lo incluye como tarea
- **H18** — F2: vertical_templates sin organization_id queda SIN RLS y ESCRIBIBLE por el rol de app — y verify:isolation pasa verde en silencio
- **H19** — F8: el «teléfono verificado» que exige ownerContext no existe como mecanismo en la plataforma, y no se excluyen los canales simulados
- **H20** — Nadie asigna brand=conversia (ni captura country) en el registro
- **H21** — Viaje del dinero del cliente Conversia sin checkout de suscripción en conversia-web y con la ruta de retorno /billing sin fijar
- **H22** — F6: el criterio de aceptación «se crea la org con el paquete instalado» no tiene herramienta ni camino definido
- **H23** — F3 pantalla 6 promete «excepciones» y «margen por servicio» contra una API de agenda que no los tiene

### MEDIO
- **H24** — F6 usa cosas que su dependencia declarada no construye: planes de F5 y panel de F3
- **H25** — F7 necesita el tenant proveedor Conversia, su agente de soporte y su número de WhatsApp — todo lo crea F6, dependencia que la tabla no declara
- **H26** — Endpoint de resumen de wallet: dueño ambiguo y contrato definido en la etapa que corre después
- **H27** — Prompt de auditoría dice «etapas F1–F9» y su punto 5 cubre «F2–F8»: F10 queda sin auditoría de producto; además apunta E1-E5 al doc histórico
- **H28** — Sobres en USD: «Lemon día 1» decidido pero el pendiente W-3 sigue abierto y ninguna etapa lo cierra — un cliente LATAM no puede comprar sobres
- **H29** — Colisión de nomenclatura «E4»: en el mismo documento E4 es «una respuesta por turno», pero F5 y COSTOS citan «pendiente E4» refiriéndose al versionado de planes
- **H30** — Conciliación estimación (ledger) vs verdad (webhook) declarada como principio, pero sin tarea, sin reporte y con doble fuente de costUsd para el mismo mensaje
- **H31** — F7 TAREA 1: POST /support/messages sin rate limit ni topes — quema de tokens de IA del proveedor y DoS del soporte de todos los clientes
- **H32** — F9: contradicción interna sobre DÓNDE vive el REVOKE — si queda solo en la migración, el próximo db:setup re-otorga UPDATE/DELETE sobre cash_ledger en silencio
- **H33** — F10: impersonación del operador sin alcance acotado — hoy el endpoint impersona como owner a CUALQUIER organización
- **H34** — En workflow-runtime el messageId NO es estable entre reintentos: la regla «no refundear antes del throw» de outbound no debe copiarse ahí
- **H35** — La convención «0 = solo medición» NO es la del vecino features.templateMessages: el código dice lo contrario
- **H36** — La cola outbound tiene un 4º productor que E2 no lista: las difusiones (broadcast.ts, PR #393) — el fix N2 las dejaría sin reintentos
- **H37** — E2 TAREA 6 especifica un test con «costo 0 con fecha de hoy» que hoy ya da 0,02
- **H38** — Referencias archivo:línea desfasadas en todo el plan (el ancla «7ddeeb7 del 30-09» es en realidad del 04-09) y la regla «manda el símbolo» vive FUERA de los prompts que se pegan
- **H39** — F2 cita cargas de seed.ts que no existen (businessHours, vocabulary, modules)
- **H40** — F4 pide implementar rescheduleAppointment, método que no existe en el contrato
- **H41** — F7 subestima su migración: support_tickets no tiene columna para el código CV-XXXX
- **H42** — Textos y alertas que ve el cliente Conversia: catálogo compartido habla de «cupo de conversaciones» que en Conversia no existe
- **H43** — Verificación de correo en el registro: prerrequisito de Fase 0 sin dueño en todo el plan
- **H44** — Acento por usuario: F3 exige persistirlo «en las preferencias del usuario (API)» pero no existe almacenamiento ni endpoint, y F3 declara «sin migración»
- **H45** — Breakpoint 980 fantasma: la auditoría lo exige y F3 nunca lo define

### BAJO
- **H46** — F5 TAREA 1 no nombra la key que acredita la bolsa en la renovación: si la sesión inventa «credits», el ciclo no acredita nada
- **H47** — F10 declara F7 como «ideal» pero su TAREA 4 (contexto total para soporte) es «CRÍTICO» y requiere F7 mergeada
- **H48** — F8 TAREA 4 habilita tools en el agente del paquete vertical (F2/F6) y menciona la pantalla F3, con dependencia declarada solo F4
- **H49** — E5 TAREA 3 dice «los 7 cambios de la tarea 1», pero la TAREA 1 lista 8 ítems
- **H50** — E4 fija «tono de WhatsApp» en el preámbulo no desactivable de TODOS los agentes; F7 lo hereda en el canal web
- **H51** — Soporte de clientes TuBot sin widget: decisión implícita que el plan no escribe
- **H52** — Tiempos verbales vencidos en los contextos de E1/E2 («hoy son gratis», «costarán», «hoy da 0»)

## Hallazgos en detalle

### H1 [BLOQUEANTE] El débito de créditos por mensajes de servicio en Conversia no lo construye ninguna etapa: los créditos vendidos nunca se agotan

**Dónde:** PROMPT E2 TAREA 2 y PROMPT E3 (decisión «bolsa SOLO de plantillas») vs PROMPT F5 (contexto y TAREAS 1/3) vs docs/CONVERSIA_COSTOS.md §0 (C2/C3/C5 y «Simplificación 2026-09-30»), §1.1 y §3.1; tabla de orden F5 («E1–E3 mergeadas (débito de servicio)»); prompt de auditoría punto 2; repo: apps/worker/src/wallet.ts:20-26

**Detalle:** Contradicción arquitectónica confirmada textualmente por ambos lados. El modelo comercial de Conversia dice que CADA respuesta del bot (servicio) descuenta créditos de la bolsa con peso 1 (COSTOS §0: «cada respuesta del bot… descuenta créditos»; C5: «utilidad 1 · servicio 1 · auth 1 · marketing 4»; 1.500 créditos ≈ 300 conversaciones), y §1.1 llega a afirmar que E1–E5 implementa «débito en bolsa sobre el umbral gratis». Falso: E2 TAREA 2 ordena que recordServiceSend escriba SIEMPRE delta 0 («la bolsa es SOLO de plantillas — no altera balance»), E3 lo sella como decisión de producto YA TOMADA (el servicio se controla por cupo de conversaciones, decisión TuBot), y F5 solo siembra planes y pesos sin tocar el flujo de débito — sembrar un peso no hace que el camino de servicio debite. F5 además declara una dependencia «E1–E3 (débito de servicio)» que no existe. Consecuencias si el plan se ejecuta tal cual: (1) un cliente Funcionando con 1.500 créditos tiene respuestas del bot ilimitadas sin gastar un crédito — la bolsa nunca se agota por servicio y los sobres de $21.900 no se venden nunca; (2) como F5 tampoco siembra conversationsPerPeriod para los planes Conversia (COSTOS dice que Conversia no usa cupo de conversaciones), el único freno al costo dominante sería el tope diario svc de E3 (default 3.000 msgs/día por tenant ≈ hasta ~$57.000 CLP/día de Meta por un cliente que paga $149.900/mes); (3) el contador de créditos de F3/F10 mostraría consumo ≈0 para un cliente cuyo costo real es mayormente servicio; (4) toda la aritmética comercial de COSTOS queda sin mecanismo y el punto 2 de la auditoría pre-prod («pesos de bolsa 1/1/1/4») verifica algo sin efecto. El criterio de aceptación de F5 («consumir → alerta al 80% → comprar sobre») pasa igual consumiendo solo plantillas, así que la sesión de desarrollo no lo detectaría. Es exactamente el «costo invisible» que E1–E5 mata para TuBot, reabierto para Conversia.

**Fix:** Decisión explícita de Javier ANTES de ejecutar F5, escrita en ambos documentos. Recomendada la opción (a), porque todos los márgenes y precios de COSTOS §0 están calculados sobre ella: agregar una tarea (en F5 o etapa nueva entre F5 y F6) que, para planes con un feature nuevo features.serviceDebitsWallet=true (sembrado solo en los planes conversia_*), haga que chargeServiceSend/recordServiceSend debite la bolsa con el peso «service» ANTES del envío (idempotente por messageId, reutilizando debitForMessage), con reembolso en fallo terminal (mismo patrón W-2), exención de los primeros 1.000 mensajes de servicio/mes por número (ver H14) y gate de bolsa en 0 para servicio en esas orgs; recordServiceSend pasa a escribir el asiento real para esas orgs y los comentarios «la bolsa es SOLO de plantillas» se actualizan a «salvo planes con serviceDebitsWallet». Sumar al criterio de aceptación de F5: «una respuesta del bot descuenta 1 crédito y aparece en el resumen por categoría», con tests de ambas marcas (una org tubot NO cambia). Si se elige la opción (b) (créditos = solo plantillas), corregir CONVERSIA_COSTOS.md §0/C5/§1.1/§3.1 y el copy de F5, recalcular los márgenes — y entonces F5 SÍ debe sembrar conversationsPerPeriod para los planes Conversia o el servicio queda sin límite comercial.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H2 [BLOQUEANTE] walletWeights es UNA key global de platform_settings: sembrar 1/1/1/4 «para orgs brand=conversia» (F5 TAREA 3) cambiaría los débitos de todos los tenants TuBot

**Dónde:** PROMPT F5 TAREA 3 («pesos… configurable en Super Admin, ya soportado») vs apps/worker/src/wallet.ts:32-48 (readWeights lee platform_settings key «walletWeights», sin override por organización ni marca), apps/api/src/platform/platform.controller.ts:1025-1036 y apps/api/src/workflows/workflows.controller.ts:606

**Detalle:** El «ya soportado» es falso: readWeights() lee una sola key global, sin parámetro de org ni de marca, y la usan el débito real (wallet.ts), la estimación de difusiones (workflows.controller.ts:606) y la calculadora del admin. La instrucción de F5 es inimplementable tal como está escrita: la sesión o (a) siembra el global con marketing:4 y TODOS los tenants TuBot pasan a descontar 4 créditos por plantilla de marketing de un día para otro — viola la decisión escrita «TuBot queda como está» (COSTOS §5), encoge en silencio el poder de compra de bolsas ya pagadas (la difusión de la empresa de 2.000 trabajadores costaría 4x en créditos) y es un cambio de precio de facto sin aviso que nada en CI ni en el plan detectaría — o (b) inventa un mecanismo por marca sin spec. Detalle adicional: el tipo Weights recién incorpora «service» en E2 (default 1, sin efecto).

**Fix:** Agregar a F5 (o F1) la tarea real que falta: resolución de pesos por marca o por plan. Mínimo concreto: key nueva platform_settings «walletWeights:conversia» con fallback a «walletWeights»; readWeights(organizationId) resuelve la marca de la org (columna brand de F1, cache 60 s) y elige la key; mismo cambio en el estimador de difusiones y la calculadora del admin. Antes de sembrar, VERIFICAR el valor actual de walletWeights en prod. Sembrar 1/1/1/4 SOLO en la key de conversia y dejar test de regresión: una org tubot sigue debitando con los pesos actuales.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H3 [BLOQUEANTE] F7: el vínculo WhatsApp↔ticket por código CV-XXXX no autentica al remitente — fuga de contexto de soporte de otro cliente

**Dónde:** PROMPT F7 TAREA 2 (docs/PROMPTS_CONVERSIA.md:1177-1185); contraste con apps/api/src/assisted-setup/assisted-setup.controller.ts:19-40 y apps/worker/src/tool-services.ts:995-1019; agravado por F10 TAREA 4 (:1354-1365)

**Detalle:** El patrón TB-XXXX del montaje es seguro por CINCO propiedades: código aleatorio (8 chars de alfabeto de 31 → ~31^8), guardado SOLO como hash SHA-256, UN SOLO USO (al canjear se anula: redeemCodeHash=null, tool-services.ts:1019), con expiración (redeemCodeExpiresAt), y el canje LIGA el grant al contacto de la conversación. F7 dice «mismo generador de códigos del montaje» pero su propio ejemplo («Ticket CV-1042») sugiere un correlativo secuencial — una sesión de desarrollo puede implementar IDs enumerables. Y aunque sea aleatorio, F7 NO hereda las demás protecciones porque son incompatibles con su flujo: el código viaja en texto prellenado de wa.me (reenviable, compartible), queda visible permanente en el widget, NO puede ser de un solo uso (debe servir mientras el ticket esté abierto), y el prompt no pide expiración, ni verificación de que el wa_id del remitente corresponda al usuario del ticket, ni límite de intentos, ni confirmación: «el webhook entrante detecta el código» y vincula AUTOMÁTICAMENTE, inyectando el historial del widget como contexto. Con F10 TAREA 4 el agente además recibe plan, estado de pago, consumo, errores y tickets previos del cliente. Resultado: un tercero que vea, adivine o reciba reenviado un código escribe al número de soporte y obtiene contexto y continuidad del ticket de OTRO cliente. Detalle técnico adicional que el prompt omite: SupportTicket vive en la org del CLIENTE (schema.prisma:427-445, bajo RLS) y el webhook corre en contexto de la org PROVEEDORA — la búsqueda del código es cross-tenant y requiere el cliente admin con índice por hash; sin decirlo, la sesión puede implementarla mal.

**Fix:** Reescribir F7 TAREA 2 con requisitos explícitos: (1) código aleatorio con el generador real (CV-XXXX-XXXX, alfabeto sin ambiguos), guardado hasheado, con TTL mientras el ticket esté abierto; (2) al detectar el código por WhatsApp, vincular SOLO si el wa_id del remitente coincide (normalizado E.164) con el teléfono del usuario del ticket; si no hay teléfono registrado o no coincide → NO inyectar contexto: responder pidiendo confirmación desde el widget (el widget muestra «¿Continuar este caso en el +56 9 …?» y el usuario autenticado confirma server-side); (3) rate-limit de intentos de canje fallidos por wa_id (contador Redis) y un solo vínculo activo por ticket; (4) auditoría del vínculo (audit_log con wa_id y ticket); (5) el lookup del código usa el cliente admin con índice por hash (patrón assisted_setup_grants_redeem_code_hash_idx); (6) el sentido inverso (panel) solo vincula tickets de ctx.organizationId.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H4 [ALTO] El plan y sus documentos base están UNTRACKED: no existen en main ni en un clon limpio

**Dónde:** git status en conversia-crm: ?? docs/PROMPTS_CONVERSIA.md, ?? docs/CONVERSIA_COSTOS.md, ?? docs/CONVERSIA_MERCADO.md, ?? docs/CONVERSIA_MONTAJE.md, ?? docs/CONVERSIA_VERTICALES.md, ?? docs/PROMPTS_SERVICIO_OCT2026.md — vs regla transversal del plan («trabajar SIEMPRE en el clon conversia-crm con main al día») y los «Lee antes» de F1-F10

**Detalle:** Cada prompt manda leer CONVERSIA_MONTAJE/VERTICALES/COSTOS y referencia «docs/PROMPTS_CONVERSIA.md», pero ninguno de esos archivos está commiteado. Una sesión que parta de un clon o worktree con main al día no los encontrará (construirá sin la arquitectura/decisiones, o se detendrá), y un git clean o cambio de máquina pierde el plan completo. También impide que la auditoría pre-prod «audite contra las especificaciones».

**Fix:** PR docs-only inmediato que commitee los 6 archivos (más PROMPTS_DIFUSIONES.md si corresponde) antes de pegar el primer prompt; borrar .commitmsg.txt/.prbody.txt residuales o agregarlos a .gitignore.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H5 [ALTO] El costo de Meta corre invisible desde hoy y el plan mantiene el ritmo de septiembre: la ventana «dos semanas de datos antes del cobro» ya no existe

**Dónde:** PROMPT E2 TAREA 3 (PROMPTS_CONVERSIA.md:252-254) y Etapa 0/checklist («siembra … tras mergear E1/E3», líneas 69-70 y 710)

**Detalle:** E2 aún promete «desde este deploy medimos el volumen real de servicio en usage_events (costo 0) — dos semanas de datos antes del cobro». Esa ventana murió: verificado que en main (9befbe6) NO existe WhatsappRateSchedule ni getWhatsappRateSchedule ni la sección en BILLING.md — E1 no está ni empezada, y cada día sin E1+E2 en prod + schedule sembrado es gasto real de Meta sin registro de costo (los asientos service_send estimarían costo 0 mientras Meta ya cobra). Además el checklist amarra la siembra de whatsappRateSchedule a «tras mergear E1/E3», pero el schedule solo necesita E1 (lector) y E2 (consumidor); solo los techos svc y los features de cupo dependen de E3. El encabezado del plan sí dice «lo PRIMERO a ejecutar», pero los cuerpos y el checklist mantienen el ritmo de septiembre.

**Fix:** Agregar una nota de re-priorización al inicio de E1–E5: ejecutar E1+E2 exprés (pueden ser el mismo día: E2 solo depende de E1) y sembrar whatsappRateSchedule EL MISMO DÍA del deploy de E2. Partir el ítem de siembra del checklist en dos: schedule (tras E2, inmediato) vs techos svc + features de cupo (tras E3). Reescribir la frase de E2 TAREA 3: «desde este deploy la medición registra el costo REAL vigente — el cobro ya corre; cada día sin deploy es costo invisible».

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H6 [ALTO] Checklist del dueño con ítems vencidos: el aviso a clientes ya va tarde y la verificación de medios de pago por WABA es urgente HOY

**Dónde:** Checklist operativo E1–E5 (PROMPTS_CONVERSIA.md:704-713), ítems «1-sep», «OK-8/A3 … riesgo del 30-09» y «22-30 sep» + PROMPT E5 TAREA 2 (líneas 653-663)

**Detalle:** Tres ítems siguen sin completar con fecha vencida: (1) «22-30 sep: disparar el aviso a clientes» — el aviso además depende del script de E5, la ÚLTIMA etapa, o sea llegará semanas después del cambio; (2) el borrador del correo pide «registrar medio de pago en Meta antes del 30-09», instrucción imposible de cumplir ya; (3) la «verificación final de medios de pago por WABA (6.1/6.2)» y la decisión A3 siguen pendientes — si hay clientes con WABA propia sin medio de pago registrado, desde HOY Meta puede dejar de entregar sus mensajes de servicio sobre el free tier y su bot se calla sin que nadie lo note. Eso es pérdida operativa real hoy, no un riesgo futuro.

**Fix:** (a) Desacoplar el aviso de E5: redactar y enviar AHORA una versión corta manual (correo Resend o anuncio in-app existente) en modo «ya rige»: «Desde el 1 de octubre WhatsApp cobra las respuestas dentro de 24 h. Esto es lo que ya hicimos en TuBot y lo que te pedimos hacer ahora», sustituyendo «antes del 30-09» por «a la brevedad»; el script idempotente de E5 queda para el refuerzo formal. (b) Mover la verificación 6.1/6.2 + decisión A3 al primer lugar del checklist con etiqueta HOY. (c) Reescribir las fechas vencidas del checklist como acciones inmediatas, no plazos.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H7 [ALTO] E1 TAREA 4 redacta como futuro («cuando Meta publique…») una verificación que debe ejecutarse HOY contra el webhook real

**Dónde:** PROMPT E1 TAREA 4 (PROMPTS_CONVERSIA.md:153-156) y Etapa 0 E (líneas 68-69, «rate card definitivo de Meta del 1-sep»)

**Detalle:** El 1-sep ya pasó y el rate card ya está publicado; peor, desde hoy los webhooks de status YA llegan con pricing.billable=true para servicio, así que la etiqueta real de categoría se puede confirmar de inmediato en prod sin esperar nada. Si Meta etiqueta distinto de «service» (p. ej. «regular» u otro valor del pricing model nuevo), computeWhatsappCostUsd la trata como desconocida y devuelve 0: el costo seguiría invisible AUNQUE E1–E2 estén desplegadas. Documentarlo como checklist futuro garantiza que nadie lo haga.

**Fix:** Cambiar E1 TAREA 4 a: «verifica AHORA contra el rate card publicado y contra un webhook de status real capturado en prod (ya llegan con billable=true desde el 1-oct): precio CL, etiqueta exacta de categoría, tramos de volumen, usdToClp». Agregar en E2 TAREA 3 un console.warn/alerta cuando llegue una categoría no reconocida en el webhook, para que una etiqueta inesperada no deje el costo en 0 en silencio. Marcar el ítem «1-sep» del checklist como acción inmediata.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H8 [ALTO] E5 instalaría copys transitorios ya vencidos: wallet.empty promete una gratuidad que ya no existe y el bot comercial citaría «hasta el 30-09 son gratis» en presente

**Dónde:** PROMPT E5 TAREA 1 ítems 1 y 7 (PROMPTS_CONVERSIA.md:619-626 y 641-645) → packages/notifications/src/catalog.ts:190 (wallet.empty) y docs/TUBOT_TENANT.md:242 (verificado: hoy dice «Responder dentro de 24 h es GRATIS»)

**Detalle:** E5 se ejecutará después del 1-oct (depende de E1–E3 mergeadas), pero sus textos se escribieron cuando el 30-09 era futuro. Ítem 1: el texto nuevo de wallet.empty dice «Hasta el 30 de septiembre puedes seguir respondiendo dentro de las 24 h sin costo; desde el 1 de octubre…» más un TODO fechado «el 1-oct se simplifica» — una sesión obediente instalaría la variante transitoria: un correo crítico (wallet.empty sale in-app Y por correo, lockedChannels in_app) afirmando a clientes una gratuidad que ya no existe, con el TODO vencido desde el primer deploy. Ítem 7: el reemplazo para TUBOT_TENANT.md incluye el paréntesis «(hasta el 30 de septiembre de 2026 son gratis)» en presente — el bot comercial de TuBot (producción, habla con prospectos reales) citaría una regla vencida como si rigiera. Es exactamente el tipo de texto falso que el propio E5 dice estar matando.

**Fix:** Reescribir ambos ítems antes de pegar E5, instalando DIRECTO las variantes finales: ítem 1 → «Tu bolsa de mensajes de plantilla llegó a 0. Compra un paquete o sube de plan para reanudar los envíos. Las respuestas dentro de las 24 h no usan esta bolsa: descuentan de tu cupo mensual de conversaciones.» (eliminar el paso intermedio y el TODO fechado); ítem 7 → quitar el paréntesis o dejarlo inequívocamente en pasado: «Las respuestas dentro de las 24 h descuentan del cupo de conversaciones del plan (eran gratis hasta el 30-09-2026). Si preguntan por precios exactos, deriva al detalle del plan — no inventes cifras.»

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H9 [ALTO] getPlanes devuelve solo planes isPublic=true: el agente comercial Conversia cotizaría los planes TuBot

**Dónde:** PROMPT F5 REGLAS («isPublic=false en la web TuBot») + PROMPT F6 TAREA 3 («conoce SOLO los planes Conversia de F5 vía getPlanes»); repo: apps/worker/src/tool-services.ts:772-776 (listPlans: where { isPublic: true, active: true }, catálogo global) y packages/agents/src/tools.ts:537

**Detalle:** F5 crea los planes conversia_* con isPublic=false y F6 exige que el comercial los conozca «vía getPlanes». Con el código actual, getPlanes NO devolvería ningún plan Conversia y SÍ devolvería los planes públicos de TuBot: el bot comercial de Conversia vendería precios y cupos de TuBot a los leads. Ninguna etapa instruye filtrar el catálogo por marca (F1 TAREA 3 solo cambia el TEXTO de la descripción del tool). Es venta con precios equivocados: plata y credibilidad.

**Fix:** En F5: columna/atributo brand (o visibilidad por marca) en la tabla plans, y listPlans filtra por brandOf(org) del tenant que consulta (público por marca), con test: org conversia ve solo conversia_*, org tubot ve exactamente lo de hoy.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H10 [ALTO] F7 (WEBCHAT) pasa por el mismo agent-turn que el medidor/freno de WhatsApp y el plan no lo excluye; además el despacho de envío enruta por contact.phone, no por canal

**Dónde:** PROMPT F7 TAREA 1-2 vs PROMPT E2 TAREA 2 y PROMPT E3 TAREA 4 (call sites «en los mismos 4 orígenes… agent-turn.ts»); repo: apps/worker/src/agent-turn.ts:584-607 (con phone → Graph API WhatsApp; sin phone → messaging-send Messenger/IG)

**Detalle:** Hipótesis 6 confirmada y peor: (1) el plan jamás dice que los envíos WEBCHAT no deben pasar por chargeServiceSend/recordServiceSend ni contar cupo — E2 solo excluye Messenger/IG; con E2/E3 instalados en agent-turn, cada respuesta del bot de soporte web se mediría con costo Meta y consumiría/frenaría el cupo de conversaciones del tenant proveedor Conversia (el soporte in-app se pausaría por «cupo lleno» como si fuera WhatsApp). (2) agent-turn decide el canal por contact.phone: F7 crea el contacto webchat «con teléfono si existe» (lo necesita para la continuidad WhatsApp) → la respuesta del widget entraría a la rama WhatsApp y se ENVIARÍA al WhatsApp real del usuario vía Graph (cobro Meta + mensaje duplicado), o quedaría FAILED al no resolver phoneNumberId del canal WEBCHAT. F7 no contiene ninguna tarea que modifique este despacho.

**Fix:** Agregar a F7 TAREA 1: (a) ramificar el envío en agent-turn.ts por channel.type — WEBCHAT = persistir + SSE, sin Graph, message directo a SENT; (b) regla explícita: WEBCHAT queda FUERA de chargeServiceSend/recordServiceSend y del cupo de conversaciones (mismo trato que Messenger/IG en E2), con test: turno webchat no escribe service_send ni marca de cupo.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H11 [ALTO] Alta y activación del ciclo Conversia sin máquina de estados: el payment-link existente ACTIVA la suscripción al pagarse, F5 y F10 se contradicen sobre el gatillo, y el trial-lifecycle purgaría orgs vendidas en espera

**Dónde:** PROMPT F5 TAREA 2 y su criterio de aceptación vs PROMPT F10 TAREA 3; apps/api/src/platform/platform.controller.ts:1560-1608 (paymentLink) y docs/BILLING.md (webhook Flow → activate()); apps/worker/src/trial-lifecycle.ts:21-80; enum OrgStatus (schema.prisma:24: ACTIVE/TRIAL/SUSPENDED/CANCELLED); apps/worker/src/subscription-billing/db-port.ts:36

**Detalle:** Verificado en código: POST /platform/organizations/:id/payment-link (PR #378) existe, pero (i) solo cobra el precio de un PLAN del catálogo (más «billables»), no admite un cobro único arbitrario, y (ii) su propio docblock dice que al pagarlo el webhook /billing/webhooks/flow ACTIVA la suscripción automáticamente — usarlo tal cual para el setup contradice la «espera de activación» de F5 TAREA 2 («el ciclo de Conversia parte cuando el equipo entrega»). Tres huecos más en el mismo estado: (1) el criterio de aceptación de F5 activa el ciclo al «marcar setup pagado», mientras F10 TAREA 3 lo dispara al «marcar ENTREGADO (si el setup está pagado)» — la sesión implementará una de las dos y quedará incoherente con la otra; implementar F5 por su criterio cobra la mensualidad desde el pago del setup, ANTES de entregar (cobro indebido y reclamo seguro con permanencia de 6 meses); además entre F5 y F10 no existe el evento ENTREGADO. (2) No se define qué OrgStatus tiene la org en espera: si queda TRIAL (default), trial-lifecycle la deshabilita al día 7 y la purga al 14 — purgaría una org VENDIDA que espera implementación o pago del setup (que puede tardar semanas); si queda ACTIVE, nunca se purga y no hay dunning del setup impago. (3) No hay transición para «nunca pagaron el setup» ni se define qué ve el cliente al entrar a conversia-web en ese estado. Trampa adicional: si la sesión modela el setup como «billable» de org.settings, se recobraría TODOS los meses (buildEngineSub suma billables en cada cobro, db-port.ts:36; payment-link también, platform.controller.ts:1584-1588).

**Fix:** Especificar en F5 TAREA 2: (1) cobro único de setup con el mecanismo que ya existe para pagos one-off — checkout con prefijo en planCode (patrón «pkg:» de buy-package, billing.controller.ts:381), p. ej. «setup:<vertical>», cuyo webhook NO llama a activate(): marca org.settings.setupPaid + factura interna de línea única; prohibir explícitamente modelarlo como billable recurrente. (2) Estado explícito en settings (conversia.lifecycle: awaiting_setup_payment | implementing | delivered) y exclusión del trial-lifecycle para orgs brand=conversia (test incluido). (3) Activación del ciclo mensual SOLO con el evento ENTREGADO: F5 expone la acción explícita separada «activar ciclo» (Super Admin) que F10 luego invoca al marcar ENTREGADO; «setup pagado» es precondición, no gatillo; corregir el criterio de aceptación de F5 a «setup pagado → espera de activación → acción activar → ciclo activo». (4) Política de expiración del setup impago (N días → notificar al equipo; purga manual documentada) y pantalla «tu cuenta está en implementación» en F3.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H12 [ALTO] Grandfathering: el modelo actual NO lo garantiza, y F5 lo exige «sin migración» cuando la versión mínima requiere DDL

**Dónde:** apps/worker/src/subscription-billing/db-port.ts:22-36 (buildEngineSub) vs PROMPT F5 (regla de grandfathering) y tabla de orden («Migración: no (seeds/config)»); CONVERSIA_COSTOS.md §0 regla 1 y §4

**Detalle:** buildEngineSub lee plan.priceClp/priceUsd VIGENTES en cada cobro: cambiar el precio de un plan en BD cambia lo que se les cobra a todas las suscripciones activas de ese plan en su próximo ciclo (lo mismo el payment-link, platform.controller.ts:1583). No hay snapshot de precio contratado en subscriptions ni versionado de planes. La estrategia completa de «precio de lanzamiento» de Conversia ($190.000 → $290.000 setup; planes «lanzamiento») depende de poder subir el precio sin tocar a los contratados; hoy subirlo re-precia retroactivamente a todos, incluidos tenants TuBot si alguien toca esos planes. F5 ordena «si el modelo actual no lo garantiza, implementarlo aquí», pero su fila en la tabla de orden declara «Migración: no (seeds/config)»: la versión mínima necesita una columna (DDL). El riesgo concreto es que la sesión lo resuelva con un hack en settings (frágil, invisible al billing) o lo declare fuera de alcance por la prohibición de migrar.

**Fix:** Corregir la fila de F5 en la tabla de orden a «sí (1: snapshot de precio en subscriptions)» y especificar el mínimo: columnas subscriptions.locked_price_clp / locked_price_usd (y yearly) selladas al contratar o cambiar de plan; buildEngineSub y paymentLink usan el snapshot si existe, con fallback al precio del plan; backfill de las suscripciones activas con el precio actual de su plan en la misma migración. Con eso, «subir el precio de lanzamiento» solo afecta contrataciones nuevas, como promete COSTOS §4.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H13 [ALTO] Overage de conversaciones: E3 lo cuenta y su copy promete «se suma a tu factura», pero ninguna etapa lo factura

**Dónde:** PROMPT E3 TAREA 2 (conversationOverageClp) y TAREA 4 (catálogo «conversations.limit»: «el excedente se suma a tu factura como sobreconsumo») vs todo F1–F10; apps/worker/src/subscription-billing/db-port.ts:98-124 (applySuccess factura solo plan + billables)

**Detalle:** E3 crea el feature conversationOverageClp (CLP por conversación extra) y el contador acumula overage, pero ninguna etapa del plan lee ese contador para cobrar: la factura del ciclo es siempre monto del plan + billables manuales (db-port.ts), F5 solo vende sobres prepagados de créditos, y F9 es la caja del negocio del cliente (otro dinero). Resultado: el texto que verá el tenant al llegar al 100% promete un cobro que no existe — o se regala el excedente para siempre (pérdida de ingreso silenciosa), o alguien lo implementa después y cobra algo anunciado pero nunca consentido con detalle (disputa segura; además viola la regla transversal 4 de COSTOS: aviso previo a todo débito). Nota: con COSTOS mandando que Conversia NO usa cupo de conversaciones y TuBot queda sin cambios, hoy no hay ningún comprador definido para conversationOverageClp — es config muerta con copy vivo.

**Fix:** Decidir y alinear: (a) si el overage SE COBRA, agregar tarea (F5 o etapa de billing) que al cierre del período agregue la línea «Sobreconsumo: N conversaciones × $X» a la factura/billables usando ConversationQuotaCounter.overage × conversationOverageClp, con aviso previo (regla 4 de COSTOS) e idempotencia por (org, período); (b) si NO se cobra al lanzamiento, cambiar el texto del catálogo en E3 a algo veraz («Sigues atendiendo sin cortes; te contactaremos para ajustar tu plan») y dejar conversationOverageClp documentado como reservado. En ambos casos, dejarlo escrito en E3 para que la sesión no herede la promesa falsa.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H14 [ALTO] El tier gratis de Meta (1.000 mensajes de servicio/mes por número) no está modelado en ninguna etapa, pero la auditoría pre-prod lo exige y COSTOS calcula todo sobre él

**Dónde:** PROMPT E1 (schedule solo por fecha) y E2 TAREA 2 (costUsd desde el mensaje 1) vs PROMPT DE AUDITORÍA PRE-PRODUCCIÓN punto 3 («1.000 gratis/mes por número y luego tarifa vigente») y encabezado E1-E5; CONVERSIA_COSTOS.md §0/§1.1/§2 («pagados sobre 1.000») y §7.4

**Detalle:** recordServiceSend (E2) calcula costUsd = computeWhatsappCostUsd('service', ...) para CADA envío desde el mensaje 1: no existe en ninguna etapa un contador mensual de servicio por número que ponga costo 0 bajo el umbral de 1.000. Tres impactos reales: (1) el ledger de estimación sobreestima el COGS hasta en ~$19.000 CLP/mes por número, y la fórmula del reporte de margen de COSTOS §7.4 usa justamente WalletLedger.costUsd — decisiones de cuotas/precios del mes 1 saldrían infladas; (2) si se adopta el débito de créditos por servicio (H1, opción a), cobrarle créditos al cliente por mensajes que Meta regala rompe la aritmética comercial de COSTOS (1.500 cr ≈ 300 conv solo cuadra con los 1.000 gratis exentos); (3) el prompt de auditoría pre-prod declararía NO-GO contra E1–E5 tal como están especificadas, porque exige verificar «1.000 gratis/mes por número» que nadie construyó — falso NO-GO, o peor, el equipo lo «arregla» a la rápida sin spec. El webhook sí trae la verdad (status.pricing.billable, que E2 TAREA 3 empieza a guardar), pero la estimación y el eventual débito no la consultan.

**Fix:** Agregar (a E2 o como tarea nueva previa a F5) un contador mensual de mensajes de servicio por número (phone_number_id + mes, Redis con respaldo en BD o agregación de usage_events), con el umbral en platform_settings (key «serviceFreeTierPerNumber», default 1000). recordServiceSend lo consulta: bajo el umbral → costUsd 0 y meta.freeTier=true; sobre el umbral → tarifa del schedule. El mismo contador exime el débito de créditos si se adopta la opción (a) de H1. Si se decide NO modelarlo, cambiar el criterio punto 3 del prompt de auditoría («conciliar estimación (ledger) vs verdad de Meta (usage_events.meta.billable); el tramo gratis lo refleja billable=false, no un contador propio»), documentar en BILLING.md que el ledger es techo (worst case) — y entonces corregir también la fórmula §7.4 de COSTOS para usar usage_events.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H15 [ALTO] Los reintentos que agrega N2 a la cola outbound son no-op (y el «no refund antes del throw» de la TAREA 4 deja una fuga de créditos)

**Dónde:** PROMPT E2 TAREA 5 (N2) y TAREA 4 primer bullet — apps/worker/src/outbound.ts:13-14, :136-138, :173; apps/api/src/queues.ts:27

**Detalle:** El diagnóstico de N2 es correcto (nadie define attempts: ni las 3 llamadas .add() de conversations.controller.ts:816/:897/:1036 ni la Queue en queues.ts:27 tienen defaultJobOptions), pero el fix propuesto no funciona: en el catch de processOutbound el mensaje se marca FAILED (outbound.ts:136-138) ANTES del throw de la línea 173, y el reintento de BullMQ vuelve a entrar por la línea 14 (`if (!message || message.status !== "PENDING") return null`) → el reintento es siempre un no-op. El plan solo nota que el check hace no-op el reintento «tras éxito», pero también lo hace tras FALLO, que es exactamente el caso que se quiere reintentar. Consecuencia doble: (a) se configura un reintento muerto; (b) la TAREA 4 ordena NO refundear antes del throw final «porque el reintento puede triunfar» — como el reintento no puede triunfar, el débito de bolsa de una plantilla que falló por error transitorio (red/5xx/429) queda cobrado para siempre: mensaje FAILED sin wamid (sin webhook «failed» que gatille el refund asincrónico) y sin devolución. Fuga real de créditos del tenant.

**Fix:** En E2, ampliar N2: el worker debe recibir el Job de BullMQ (main.ts pasa job.data; cambiar a pasar el job o attemptsMade/opts.attempts) y en el catch de errores genéricos de outbound.ts: si NO es el último intento, dejar el message en PENDING (no marcar FAILED) y hacer throw; si ES el último intento, marcar FAILED y, si era TEMPLATE, llamar refundForMessage antes de rethrow. Así el reintento es real y el débito no se fuga.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H16 [ALTO] F10: falta la tarea de enforcement RBAC default-deny — el token del operador hoy valdría para TODO /platform/*

**Dónde:** PROMPT F10 REGLAS (docs/PROMPTS_CONVERSIA.md:1315-1320) y TAREA 5; apps/api/src/platform/platform.guard.ts (no consulta claims.role en ninguna parte); apps/api/src/platform/platform.controller.ts (cero chequeos de rol); packages/database/prisma/schema.prisma:195 (role existe pero no se usa)

**Detalle:** PlatformGuard valida token + sesión Redis + MFA, pero NO mira el rol: cualquier fila de platform_admins puede llamar cualquier endpoint de /platform/* (cost-settings, planes, fusibles, suspensiones, billing). La columna role («owner|admin|support|billing|readonly») existe desde antes y ningún endpoint la consulta. Si la sesión F10 crea el rol «operador» y solo agrega sus pantallas/endpoints nuevos, las prohibiciones de la REGLA («NO puede tocar platform_settings, planes, fusibles…») quedan en el papel: el operador sería Super Admin de facto llamando la API directo. El plan pide tests de lo prohibido pero no nombra el mecanismo ni advierte que hay que cubrir TODOS los endpoints EXISTENTES, que es donde una sesión falla.

**Fix:** Agregar a F10 una tarea explícita: autorización por rol en PlatformGuard (o decorador @PlatformRole) con DEFAULT-DENY para role='operador' — allowlist de los endpoints de consola permitidos; todo endpoint no listado responde 403 para operador. Test obligatorio que recorre TODAS las rutas /platform/* registradas con un token de operador y espera 403 fuera de la allowlist (así los endpoints futuros nacen negados).

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H17 [ALTO] MFA obligatorio del operador: el propio plan lo declara «bloqueante de auditoría» y F10 no lo incluye como tarea

**Dónde:** PROMPT F10 (REGLAS y TAREAS, sin tarea MFA) vs sección de brechas / «Qué queda fuera» (docs/PROMPTS_CONVERSIA.md:1531-1532); apps/api/src/platform/platform.guard.ts:58-71; docs/SUPER_ADMIN_SECURITY.md §3/§8 (desactualizado)

**Detalle:** La sección «Brechas» del propio plan dice: «MFA obligatorio para el rol operador: si no entró en F10, es bloqueante de auditoría» — y F10 no lo contiene: el plan se auto-programa un NO-GO y una vuelta de retrabajo sobre un rol que puede impersonar clientes. Es el único ítem de «Qué queda fuera» mal clasificado: no puede ser a la vez diferible y bloqueante de lanzamiento. El fix es casi gratis: el MFA de plataforma YA está implementado (TOTP + recovery codes + sesiones Redis) y PlatformGuard ya bloquea todo /platform/* a admins sin mfaEnabledAt… pero condicionado a la env SUPER_ADMIN_REQUIRE_MFA (guard :60) — si esa flag no está en prod, nadie tiene MFA forzado. Riesgo adicional: F10 obliga a leer SUPER_ADMIN_SECURITY.md, que está DESACTUALIZADO (§3 y §8 dicen que MFA y gestión de sesiones son «Fase A — pendiente de implementar» cuando ya existen en platform-auth.controller.ts/platform-session.service.ts) — la sesión puede concluir erróneamente que no hay mecanismo que reutilizar y construir uno paralelo.

**Fix:** Agregar a F10: (1) los operadores viven en platform_admins con role='operador' (heredan login, sesiones Redis y el gate MFA del guard — no construir identidad paralela); (2) MFA incondicional para role='operador' (o verificar y documentar SUPER_ADMIN_REQUIRE_MFA=true en prod como prerrequisito del deploy de F10) — sin MFA enrolado no puede impersonar ni operar fichas; (3) test: operador sin mfaEnabledAt no pasa de /platform/auth/*. Además, actualizar SUPER_ADMIN_SECURITY.md §3/§8 al estado real antes de pegar F10 y quitar el ítem de la lista de diferidos.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H18 [ALTO] F2: vertical_templates sin organization_id queda SIN RLS y ESCRIBIBLE por el rol de app — y verify:isolation pasa verde en silencio

**Dónde:** PROMPT F2 TAREA 1 (docs/PROMPTS_CONVERSIA.md:806-813); packages/database/sql/setup.sql:39-42 (GRANT global) y :44-106 (RLS solo a tablas con organization_id + globales tratadas una a una); packages/database/src/verify-isolation.ts:106-128 (el barrido solo enumera tablas con organization_id)

**Detalle:** La migración NO rompe el check de aislamiento — es peor: pasa verde sin mirar la tabla. El loop de RLS de setup.sql solo cubre tablas con columna organization_id, y las globales se protegen con bloques escritos A MANO (organizations, users, platform_admins, plans). Una tabla nueva sin organization_id y sin bloque propio queda SIN RLS, y la línea 39 (GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES + default privileges :41-42) le da ESCRITURA al rol conversia_app. La definition de un paquete contiene los systemPrompt de los agentes que se instalan en los tenants: cualquier vía de escritura desde contexto de tenant (bug futuro, inyección SQL) permite envenenar los agentes de todos los clientes nuevos — inyección de prompt almacenada a escala. El plan dice «gestionada por Super Admin» pero no dice cómo se protege en setup.sql ni cómo la lee el endpoint tenant POST /onboarding/vertical (con deny-all la lectura fallaría y la sesión lo «arreglaría» abriendo permisos).

**Fix:** Opción preferida: darle a vertical_templates organization_id String? nullable (patrón AgentTemplate, schema.prisma:1115-1126): el loop de setup.sql le aplica RLS automáticamente y las filas globales (NULL) quedan invisibles e inmutables para el rol de app; el instalador y los endpoints las leen con el cliente admin (como el catálogo de planes). Alternativa: bloque explícito en setup.sql con ENABLE+FORCE RLS + política solo-SELECT de plantillas activas (patrón plans, setup.sql:102-106). En ambos casos, el prompt F2 debe decir: actualizar setup.sql, re-ejecutar db:setup tras la migración, y sumar a verify-isolation.ts el caso «INSERT/UPDATE de vertical_templates con rol de app → rechazado».

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H19 [ALTO] F8: el «teléfono verificado» que exige ownerContext no existe como mecanismo en la plataforma, y no se excluyen los canales simulados

**Dónde:** PROMPT F8 REGLAS (docs/PROMPTS_CONVERSIA.md:1209-1215) y TAREA 2 (:1226-1227); packages/database/prisma/schema.prisma:345 (users.phone String? libre); apps/api/src/auth (sin flujo de verificación de teléfono); docs/MULTITENANCY.md §Superficies (canal mock acepta cualquier teléfono)

**Detalle:** El doble cerrojo (habilitación por versión de agente + verificación en runtime) está bien enunciado, y «el CONTACTO de la conversación» implica razonablemente el wa_id autenticado del webhook de Meta (no texto del mensaje) — aunque conviene decirlo explícito. El hueco real: users.phone es un String libre que el usuario tipea en su perfil; NO existe ningún flujo de verificación de teléfono (OTP) en el código. La REGLA dice «teléfono verificado vinculado a su cuenta» asumiendo un mecanismo inexistente, y ninguna tarea lo construye: la sesión caería en silencio a comparar contra el teléfono auto-declarado. Un número mal tipeado (o puesto con malicia) le entrega a un tercero, por WhatsApp, las tools de administración de agenda (bloquear horarios, cancelar citas de clientes, dar de baja profesionales). Segundo hueco: el canal mock/simulador (simulate-inbound, live-sim) fabrica contactos con CUALQUIER teléfono — un contacto simulado con el número del dueño activaría ownerContext en un entorno donde el teléfono no está autenticado por Meta.

**Fix:** Agregar a F8 TAREA 2: (1) campo users.phoneVerifiedAt + flujo de vinculación verificada reutilizando el patrón TB del montaje (el panel genera un código de un solo uso, hasheado y con TTL; el dueño lo envía por WhatsApp desde su número y el worker lo canjea ligando wa_id↔usuario) — jamás confiar en users.phone sin verificar; (2) la resolución compara números normalizados (E.164) contra el wa_id del webhook y exige phoneVerifiedAt; (3) ownerContext SOLO para canal WHATSAPP de proveedor real — explícitamente nunca en canal mock, sandbox ni workflow-live-sim; (4) test de que un contacto simulado con el teléfono del dueño NO recibe las tools.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H20 [ALTO] Nadie asigna brand=conversia (ni captura country) en el registro

**Dónde:** PROMPT F2 TAREA 3 y PROMPT F3 TAREA 1; apps/api/src/auth/auth.controller.ts:24 (registerSchema: solo email/password/name/organizationName); schema.prisma:367 (country existe, default CL)

**Detalle:** F1 crea la columna brand (default tubot), F2 agrega «vertical» al registerSchema y F3 construye /registro en conversia-web — pero ningún prompt dice CÓMO el registro desde conversia-web fija brand=conversia. Sin tarea, todas las orgs registradas en app.conversia.cl quedan brand tubot (correos, planes visibles, proveedor de montaje y retornos de Flow equivocados); y si el dev improvisa aceptando brand desde el body, es spoofeable (una org cualquiera se declara conversia y cambia qué org proveedora recibe el grant de montaje). Lo mismo con country: Organization.country existe con default CL pero registerSchema no lo captura y la decisión es «Chile + LATAM desde el inicio» — el acento por país de F3 siempre resolvería Menta/CL, y currency/pasarela (CLP→Flow, resto→Lemon en payment-provider.ts) quedan mal para clientes LATAM. Solo el wizard F10 (última etapa) captura país.

**Fix:** En F2 TAREA 3 (o F1): register deriva brand server-side por allow-list de Origin ([WEB_URL→tubot, WEB_URL_CONVERSIA→conversia], default tubot) con test de que el body no puede forzarlo; y agrega country (ISO-3166 validado, default CL) al registerSchema, derivando currency. En F3: el registro pide país (selector) y lo envía.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H21 [ALTO] Viaje del dinero del cliente Conversia sin checkout de suscripción en conversia-web y con la ruta de retorno /billing sin fijar

**Dónde:** PROMPT F3 TAREA 2 pantalla 5 y PROMPT F5 TAREAS 2-3; apps/api/src/billing/billing.controller.ts:349 y :386 (successUrl ${WEB_URL}/billing y /settings/plan)

**Detalle:** La pantalla 5 de F3 lista «compra de sobres» e «historial», pero: (a) ninguna tarea construye cómo el cliente conversia CONTRATA la suscripción/registra su tarjeta recurrente — en TuBot ese checkout vive en /settings/plan (billing.controller.ts:386) y conversia-web no lo tiene en su lista de pantallas; sin eso, la mensualidad no se puede cobrar salvo link manual mes a mes; (b) el retorno de Flow y los links de los eventos del catálogo (E3: link «/billing»; buy-package retorna a ${webUrl}/billing?paid=1) exigen que conversia-web implemente exactamente la ruta /billing — F3 no fija la ruta y si la nombra distinto (p. ej. /facturacion) se rompen retorno y notificaciones. (La compra de sobres en USD para LATAM es un hueco aparte: ver H28.)

**Fix:** F3 pantalla 5: agregar explícitamente «contratar/actualizar suscripción (reusa createCheckoutSession)» y fijar la ruta /billing con manejo de ?paid=1.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H22 [ALTO] F6: el criterio de aceptación «se crea la org con el paquete instalado» no tiene herramienta ni camino definido

**Dónde:** PROMPT F6 (criterio de aceptación) y TAREA 2; schema.prisma:388-421 (AssistedSetupGrant: lo autoriza un usuario del CLIENTE desde su panel); PROMPT F3 TAREA 2 (sin pantalla de autorización de montaje)

**Detalle:** La demo de punta a punta de F6 exige: lead → el comercial vende → «se crea la org con el paquete instalado» → el agente de implementación monta con sus tools. Pero (1) la única tool nueva es installVerticalPackage, que opera sobre una org EXISTENTE — ninguna tool ni endpoint del flujo crea la org + el usuario dueño + envía credenciales (el wizard que lo hace es F10, etapa posterior; F6 solo depende de F2); (2) el montaje asistido requiere que el CLIENTE autorice el grant desde SU panel y dicte el código TB/CV-XXXX — y la lista de pantallas de F3 no incluye la pantalla de autorización de montaje en conversia-web, así que aunque la org exista, el agente de implementación no puede obtener el grant. La sesión F6 no puede cumplir su criterio tal como está escrito.

**Fix:** Definir el camino en F6: (a) autoservicio — el comercial envía el link /registro?vertical= (el registro crea org+usuario e instala el paquete, F2 TAREA 3) y se agrega a F3 (o F6) la pantalla de autorización del montaje asistido en conversia-web; o (b) alta operada — el criterio dice explícitamente que la org la crea el Super Admin (procedimiento manual documentado hasta F10). En ambos casos, nombrar quién envía las credenciales al cliente (invitación existente).

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H23 [ALTO] F3 pantalla 6 promete «excepciones» y «margen por servicio» contra una API de agenda que no los tiene

**Dónde:** PROMPT F3 TAREA 2 pantalla 6 (y PROMPT F8 TAREA 1) vs apps/api/src/scheduling/agenda.controller.ts:137-157 y packages/scheduling/src

**Detalle:** F3 afirma que la pantalla de configuración de agenda se construye «todo contra la API de agenda nativa existente (agenda.controller.ts ya expone el CRUD de config)». El código lo desmiente en dos de los cuatro puntos listados: (1) EXCEPCIONES (feriados, vacaciones, bloqueos puntuales) no existen en ninguna parte — no hay endpoint, no hay modelo en schema.prisma y computeNativeSlots no recibe excepciones (grep de timeOff/exception/feriado en packages/scheduling/src: cero resultados; la disponibilidad solo resta citas ocupadas); (2) el MARGEN es global (settings.agenda.bufferMin en GET/PUT /agenda/config), no «por servicio» como pide la pantalla. Lo que sí existe: horarios por persona día a día (meta.workingHours con bloques, PUT /agenda/professionals/:id), duración por servicio (Service.durationMin) y anticipación mínima (minAdvanceMin). Además ninguna otra etapa crea ese almacenamiento: F4 es reagendar/cancelar/confirmar y F8 (addProfessionalTimeOff) asume un time-off que tampoco existe. Una sesión F3 se topa con una API inexistente y o inventa un endpoint fuera de alcance o entrega la pantalla incompleta.

**Fix:** Agregar a F4 (que ya toca el motor de agenda y va en paralelo, antes de que F3 llegue a la pantalla 6) una subtarea explícita: modelo professional_time_off (o settings/meta.exceptions) + endpoints CRUD en agenda.controller + soporte de excepciones en computeNativeSlots. En F3, reescribir la frase: «horarios/duración/anticipación contra la API existente; excepciones contra la API nueva de F4». Decidir además si «margen por servicio» se baja a «margen global» (lo que hay) o se agrega bufferMin por servicio en esa misma subtarea.

*Verificación adversarial: 2 refutadores, 0 refutan.*

### H24 [MEDIO] F6 usa cosas que su dependencia declarada no construye: planes de F5 y panel de F3

**Dónde:** Tabla «Orden y dependencias» fila F6 («Depende de: F2 mergeada», «ideal F1») vs PROMPT F6 TAREA 3 y su criterio de aceptación

**Detalle:** F6 TAREA 3 crea el agente comercial que vende «SOLO los planes Conversia de F5 vía getPlanes» (sin F5 no hay planes que vender) y la aceptación termina con «el cliente queda operando en conversia-web» (sin F3 no existe esa app). Una sesión F6 corrida tras solo F2 — lo que la tabla permite — no puede cumplir su propio criterio de aceptación y probablemente improvise (p. ej. hardcodear precios en el prompt del agente, violando la regla 2 de CLAUDE.md).

**Fix:** En la tabla: F6 depende de «F2 + F5 mergeadas (ideal F1, F3 para la demo de aceptación)». O bien partir la aceptación en dos niveles: sin F3/F5 se valida solo la instalación del contenido vertical.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H25 [MEDIO] F7 necesita el tenant proveedor Conversia, su agente de soporte y su número de WhatsApp — todo lo crea F6, dependencia que la tabla no declara

**Dónde:** Tabla «Orden y dependencias» fila F7 («Depende de: F1 y F3 mergeadas») vs PROMPT F7 (contexto: «agente de soporte IA del tenant proveedor (Conversia)»; TAREA 2: wa.me del número de soporte) y PROMPT F6 TAREA 3 / Etapa 0 («Crear la organización tenant Conversia cuando F6 lo pida»)

**Detalle:** El chat del widget aterriza como conversación en la org proveedora Conversia y lo responde su agente de soporte — ambos se crean recién en F6 (tenant comercial + agentes + grant por marca), y el botón «Seguir en WhatsApp» necesita además el número de soporte de ese tenant conectado. Si F7 corre antes de F6 (permitido por la tabla), POST /support/messages no tiene dónde crear la conversación ni quién la responda, sus pruebas (TAREA 4) no pueden correr, y la sesión quedaría bloqueada o crearía un tenant ad-hoc fuera de spec.

**Fix:** Corregir la fila F7 de la tabla: «Depende de F1, F3 y F6 (tenant proveedor con agente de soporte y número conectado)» — o declarar en F7 el fallback de staging: usar la org proveedora TuBot existente en dev y parametrizar la org proveedora por marca (como ya hace F6 con el grant de montaje).

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H26 [MEDIO] Endpoint de resumen de wallet: dueño ambiguo y contrato definido en la etapa que corre después

**Dónde:** PROMPT F3 TAREA 2 pantalla 5 («si falta endpoint de resumen, crearlo en apps/api/src/billing» — sin ruta ni shape) vs PROMPT F5 TAREA 4 («si no salió en F3»: GET /billing/wallet/summary con contrato exacto); repo: solo existe GET /billing/wallet (billing.controller.ts:289, saldo + packages — el resumen NO existe)

**Detalle:** Los prompts son autocontenidos y F3 corre antes: la sesión F3 inventará su propia ruta y shape (no conoce el contrato que F5 especifica), y la sesión F5, al ver que «salió en F3», saltará la TAREA 4 COMPLETA — incluidas las alertas al 80% por correo/push, que F3 no construye por ningún lado. Resultado probable: endpoint con contrato distinto al spec + alertas de 80% que nadie implementa (y que el prompt de auditoría punto 2 sí exige).

**Fix:** Mover el contrato completo a F3 (GET /billing/wallet/summary → saldo, consumo del mes por categoría, proyección simple, umbral 80% sí/no) y reescribir F5 TAREA 4 como incondicional: «verifica que el endpoint de F3 cumpla el contrato y agrega las alertas 80% por notificaciones».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H27 [MEDIO] Prompt de auditoría dice «etapas F1–F9» y su punto 5 cubre «F2–F8»: F10 queda sin auditoría de producto; además apunta E1-E5 al doc histórico

**Dónde:** PROMPT DE AUDITORÍA PRE-PRODUCCIÓN, encabezado («docs/PROMPTS_CONVERSIA.md (etapas F1–F9)») y punto 5 («PRODUCTO (F2–F8 contra sus specs)»); referencia a docs/PROMPTS_SERVICIO_OCT2026.md como spec de E1-E5

**Detalle:** Existe F10 (consola de operación, «corazón operativo del modelo llave en mano») pero la lista de especificaciones dice F1–F9 y el punto 5 audita producto solo F2–F8 — de F10 solo se revisan aristas de seguridad en el punto 1 (rol operador). El wizard de alta, el semáforo de cartera y buildClientContext quedarían sin contraste contra su spec en el GO/NO-GO. Además la auditoría manda auditar E1-E5 contra PROMPTS_SERVICIO_OCT2026.md, que el propio plan declara «referencia histórica» (verificado que hoy ambos E1-E5 son idénticos, pero divergirán si se edita una copia).

**Fix:** Encabezado: «etapas F1–F10». Punto 5: «PRODUCTO (F2–F8 y F10 contra sus specs)» agregando wizard F10 idempotente + semáforo derivado del checklist. Cambiar la referencia E1-E5 a «docs/PROMPTS_CONVERSIA.md (sección E1–E5)» y borrar el bloque E de PROMPTS_SERVICIO_OCT2026.md dejando solo un puntero.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H28 [MEDIO] Sobres en USD: «Lemon día 1» decidido pero el pendiente W-3 sigue abierto y ninguna etapa lo cierra — un cliente LATAM no puede comprar sobres

**Dónde:** Etapa 0 del plan («pendiente W-3 para sobres en USD») y PROMPT DE AUDITORÍA §7 («Lemon si LATAM día 1») vs docs/PENDIENTES.md W-3; apps/api/src/billing/billing.controller.ts:364-393 (buy-package) y payment-provider.ts:100 (Lemon exige variantId); PROMPT F3 pantalla 5

**Detalle:** COSTOS fija «Chile + LATAM desde el inicio» y F5 siembra priceUsd (~USD 23 el sobre), pero la compra de paquete hoy solo funciona por Flow (CLP) + mock: LemonSqueezyPaymentProvider.createCheckout lanza error si no hay variantId, y el flujo «pkg:<code>» no tiene variante LS (es exactamente el pendiente W-3: producto one-off en LS + webhook order_created). Ninguna etapa F lo implementa — el plan lo nombra en Etapa 0 como si fuera operativo, pero es desarrollo. Consecuencia: un cliente LATAM que agote sus créditos no tiene camino de compra; si además se adopta el débito de servicio por bolsa (H1, opción a), su bot queda mudo sin forma de recargar. Tampoco está en el checklist de Etapa 0 crear las variantes LS de los planes Conversia (sin variantId, ni siquiera el checkout de suscripción USD funciona).

**Fix:** Agregar W-3 como tarea explícita de F5 (producto de pago único en Lemon Squeezy + manejo de order_created acreditando «pkg:» con la idempotencia de webhookEvent ya existente), o decidir por escrito «LATAM se lanza sin sobres» (o «lanzamiento cobra solo CLP/Flow; LATAM se cobra manual») y ajustar el §7 del prompt de auditoría y el copy comercial. Agregar al checklist de Etapa 0: crear en LS las variantes de conversia_funcionando/gestionado (y del sobre si W-3 se hace) y cargar sus variantId en los planes.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H29 [MEDIO] Colisión de nomenclatura «E4»: en el mismo documento E4 es «una respuesta por turno», pero F5 y COSTOS citan «pendiente E4» refiriéndose al versionado de planes

**Dónde:** PROMPT F5 («es el pendiente E4 de billing en versión mínima») y CONVERSIA_COSTOS.md §0 regla 1 y §4 («El pendiente E4 (versionado de planes)») vs PROMPT E4 del propio PROMPTS_CONVERSIA.md

**Detalle:** La sesión que ejecute F5 tiene instruido leer CONVERSIA_COSTOS.md y este mismo plan. Al buscar «E4» para entender el grandfathering encontrará el PROMPT E4 (una sola respuesta por turno) — mergeado para entonces — y puede concluir que «el pendiente E4 ya está hecho» y saltarse el grandfathering, o perder la sesión persiguiendo la referencia equivocada. El «E4 de billing» real es el ítem «Versionado de planes» de PLANS_AND_LIMITS.md §5 (nomenclatura de otro backlog que no existe con ese código en ningún doc citado por F5).

**Fix:** Renombrar la cita en F5 y en CONVERSIA_COSTOS.md: «el pendiente «versionado de planes» (docs/PLANS_AND_LIMITS.md §5)» en vez de «pendiente E4», y en F5 dejar explícito que NO se refiere al PROMPT E4 de este plan.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H30 [MEDIO] Conciliación estimación (ledger) vs verdad (webhook) declarada como principio, pero sin tarea, sin reporte y con doble fuente de costUsd para el mismo mensaje

**Dónde:** PROMPT E2 TAREA 3 («Nunca se suman: se concilian por externalId» — solo un comentario en service-metering.ts) vs CONVERSIA_COSTOS.md §7.4 (fórmula de margen con WalletLedger.costUsd) y «Qué queda fuera» (reporte de margen pospuesto)

**Detalle:** Tras E2, cada mensaje (plantilla y servicio) tendrá costUsd en DOS tablas: wallet_ledger (estimación al enviar) y usage_events (verdad del webhook de Meta, con billable). El plan ordena no sumarlas, pero no construye nada que las concilie ni fija qué fuente usa cada reporte: la fórmula de margen de COSTOS §7.4 usa WalletLedger.costUsd (la estimación, que además sobreestima servicio por el tier gratis — H14), el reporte de margen quedó «para después», y la única verificación es manual en la auditoría pre-prod («cuadrar una muestra»). Riesgo real: cualquier consulta/vista futura que sume ambas tablas duplica el COGS, y las decisiones de cuotas del mes 1 (regla 6 de COSTOS) se toman sobre la fuente equivocada sin que nadie lo note.

**Fix:** Elevar el principio a regla escrita en docs/BILLING.md (no solo un comentario de código): «margen y COGS reales = usage_events (webhook, billable); wallet_ledger = control de débito/estimación», y agregar a E2 TAREA 3 (o a la matriz de tests) la consulta de conciliación por externalId (messages.external_id → wallet_ledger.refId vía message.id) con umbral de desviación, para correrla en el checklist del dueño de fin de mes 1.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H31 [MEDIO] F7 TAREA 1: POST /support/messages sin rate limit ni topes — quema de tokens de IA del proveedor y DoS del soporte de todos los clientes

**Dónde:** PROMPT F7 TAREA 1 (docs/PROMPTS_CONVERSIA.md:1172-1176); patrón existente en apps/api/src/organizations/support.controller.ts:33-35 (RateLimitService 5/10min); fusible aiTokensDaily en apps/worker/src/agent-turn.ts

**Detalle:** Cada mensaje al widget dispara un turno del agente de soporte (Opus) pagado por el tenant proveedor Conversia. El prompt no pide ningún límite. Un usuario autenticado de cualquier tenant cliente (o una cuenta comprometida, o un script) puede floodear: costo directo en tokens + efecto lateral peor: el fusible aiTokensDaily que cortaría es el del TENANT PROVEEDOR, compartido por el soporte de TODOS los clientes — un solo abusador deja sin soporte a toda la cartera. El endpoint actual POST /support ya usa RateLimitService (5 tickets/10min por usuario), así que el patrón de reutilización existe y es barato.

**Fix:** Exigir en F7 TAREA 1: rate limit por usuario Y por organización reutilizando RateLimitService (p.ej. 10 mensajes/min y 200/día por usuario; techo diario por org), máximo de tickets abiertos simultáneos por usuario, largo máximo del mensaje en el zod (p.ej. 4000 chars como el ticketSchema actual), respuesta 429 con texto amable, y una fila en la TAREA 4 de pruebas (flood → frenado sin tumbar el soporte de otros tenants).

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H32 [MEDIO] F9: contradicción interna sobre DÓNDE vive el REVOKE — si queda solo en la migración, el próximo db:setup re-otorga UPDATE/DELETE sobre cash_ledger en silencio

**Dónde:** PROMPT F9 REGLA 1 (docs/PROMPTS_CONVERSIA.md:1249-1252, dice «en sql/setup.sql») vs TAREA 1 (:1279-1280, dice «Migración: ... revocación»); packages/database/sql/setup.sql:39-42; runbook de docs/DEPLOYMENT.md (re-ejecutar setup.sql tras cada migración)

**Detalle:** setup.sql:39 ejecuta GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES TO conversia_app en CADA ejecución (y es por diseño re-ejecutable tras cada migración, según su propio encabezado y el runbook). Si la sesión de F9 pone el REVOKE en el SQL de la migración (como sugiere la TAREA 1) y no en setup.sql, la siguiente corrida de db:setup re-otorga UPDATE/DELETE sobre cash_ledger y cash_closures sin que nadie lo note — y la garantía número 1 del módulo de dinero («inmutable a nivel de BD») muere en silencio. Verificado en el código, dos dudas laterales quedan descartadas: (a) TRUNCATE NO está otorgado al rol de app (el grant es solo S/I/U/D) — hoy no puede truncar ninguna tabla; (b) el rol de migraciones usa la conexión admin (DIRECT_DATABASE_URL) y no se ve afectado por un REVOKE al rol de app.

**Fix:** Precisar en F9: el REVOKE UPDATE, DELETE (y TRUNCATE como cinturón explícito) sobre cash_ledger y cash_closures vive en sql/setup.sql INMEDIATAMENTE DESPUÉS del GRANT global de la línea 39 (idempotente; puede duplicarse en la migración, pero setup.sql es el que manda), + comentario de jamás cambiar ese GRANT a ALL PRIVILEGES; y agregar al criterio de aceptación: correr pnpm db:setup y verificar con has_table_privilege('conversia_app','cash_ledger','UPDATE') = false que la revocación sobrevive a la re-ejecución.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H33 [MEDIO] F10: impersonación del operador sin alcance acotado — hoy el endpoint impersona como owner a CUALQUIER organización

**Dónde:** PROMPT F10 REGLAS (docs/PROMPTS_CONVERSIA.md:1316-1317, «impersonar CON auditoría») y TAREA 2 «Acciones rápidas»; apps/api/src/platform/platform.controller.ts:547-576

**Detalle:** El endpoint actual de impersonación está bien construido para Super Admin: token de tenant de 30 minutos, rol owner, claim imp con el id del admin, y asiento de auditoría. Si el operador lo reutiliza hereda eso (bien), pero el plan no especifica: (a) a QUÉ organizaciones puede impersonar un operador — hoy el endpoint acepta cualquier :id, incluidas orgs tubot ajenas a su trabajo; impersonar = poderes de owner del tenant, con acceso a conversaciones, caja (F9) y datos de clientes finales; (b) que el audit registre el ROL del actor (hoy solo actorId); (c) si corresponde step-up antes de impersonar. «Alcance y expiración auditados igual que Super Admin» no basta cuando el operador es un rol de menor confianza con cartera acotada.

**Fix:** En F10: restringir la impersonación del operador a su cartera (p.ej. solo orgs brand=conversia, o asignación explícita operador↔org), manteniendo TTL 30 min y claim imp; registrar role en el claim y en el audit_log; test: operador impersonando una org fuera de su cartera → 403 auditado. Opcional (barato con el MFA ya implementado): exigir re-verificación TOTP (step-up) antes de emitir el token de impersonación.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H34 [MEDIO] En workflow-runtime el messageId NO es estable entre reintentos: la regla «no refundear antes del throw» de outbound no debe copiarse ahí

**Dónde:** PROMPT E2 TAREA 4 segundo bullet — apps/worker/src/workflow-runtime.ts:416-428, :480-494; packages/workflows/src/index.ts:646-659

**Detalle:** El plan dice «workflow-runtime.ts (~:452-466): fallo del envío del nodo sendTemplate → refund» sin distinguir salidas. El motor de workflows SÍ reintenta nodos (loop `for (let attempt = 0; ; attempt++)` en packages/workflows/src/index.ts:646-659), y cada reintento re-ejecuta sendTemplate, que crea un message NUEVO (workflow-runtime.ts:416-428) y debita un messageId NUEVO. A diferencia de outbound (messageId estable), aquí el débito del intento fallido queda huérfano: si el dev aplica por simetría la regla de outbound («en el throw no refundees»), cada reintento del motor fuga un crédito. Además hoy el `~:452-466` del plan cae dentro de la rama gate.blocked (el catch real del envío está en :480-494): un dev guiado por línea agregaría el refund en la rama equivocada.

**Fix:** Precisar en E2: en sendTemplate el refund va en TODAS las salidas del catch (los dos return de ChannelAuthError/ChannelConfigError Y antes del `throw err` de :493), explicando que el messageId se regenera por intento. Actualizar la referencia ~:452-466 → catch de sendTemplate :480-494.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H35 [MEDIO] La convención «0 = solo medición» NO es la del vecino features.templateMessages: el código dice lo contrario

**Dónde:** PROMPT E3 TAREA 2 — apps/worker/src/wallet.ts:63-67 (quotaFromPlanIncluded)

**Detalle:** E3 declara la convención del cupo de conversaciones como «OBLIGATORIA (es la del vecino features.templateMessages)»: 0 = sin cupo definido → SOLO medición. Pero en wallet.ts:63-67 templateMessages=0 significa bolsa sembrada con 0 créditos → plantillas BLOQUEADAS (comentario literal: «0 = plan sin cupo (p. ej. Free)»). Es la semántica opuesta. Como E3 siembra conversationsPerPeriod: 0 en TODOS los planes, un dev que resuelva la ambigüedad «siguiendo al vecino» dejaría el bot mudo en toda la plataforma al desplegar (cupo 0 = bloqueo). Los tests exigidos («cupo 0 = todo pasa sin avisos») protegen, pero la justificación de la convención está desmentida por el código y es una trampa.

**Fix:** Quitar la frase «es la del vecino features.templateMessages» y declarar la convención como propia y nueva: 0 = enforcement apagado (solo medición), -1 = ilimitado, N>0 = cupo — subrayando que es DISTINTA de templateMessages, donde 0 bloquea.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H36 [MEDIO] La cola outbound tiene un 4º productor que E2 no lista: las difusiones (broadcast.ts, PR #393) — el fix N2 las dejaría sin reintentos

**Dónde:** PROMPT E2 — DATO CLAVE y TAREA 5 (N2) (PROMPTS_CONVERSIA.md:179-191 y 280-287) vs apps/worker/src/broadcast.ts:117 (PR #393, 2026-09-30)

**Detalle:** La auditoría base de E2 es del 2026-08-31; el 2026-09-30 se mergeó #393 (difusiones): broadcast.ts:117 crea Messages TEMPLATE y los encola en la misma cola outbound, sin attempts. Los 4 orígenes de SERVICIO siguen siendo correctos (la difusión es plantilla), pero: (a) la afirmación «la cola outbound solo lleva mensajes del panel (humanos)» ya es falsa y confundirá a la sesión que la verifique (o la hará instrumentar mal); (b) N2 ordena poner attempts:3 solo en «las 3 llamadas .add()» de conversations.controller.ts (:816/:897/:1036 — verificadas vigentes) y deja la difusión masiva sin reintentos: en un envío a 2.000 destinatarios (el caso real de TuBot Difusiones), cualquier fallo transitorio de Graph = mensajes FAILED sin retry (W-2 devuelve el crédito, pero la entrega se pierde).

**Fix:** Actualizar E2: «la cola outbound lleva mensajes del panel Y de difusiones (broadcast.ts, #393); el bot no pasa por ella», y en N2 incluir el 4º call site apps/worker/src/broadcast.ts:117 — o mejor, definir defaultJobOptions { attempts: 3, backoff } al construir la Queue outbound (apps/api/src/queues.ts:27 y getOutboundQueue del worker) para no perseguir call sites futuros.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H37 [MEDIO] E2 TAREA 6 especifica un test con «costo 0 con fecha de hoy» que hoy ya da 0,02

**Dónde:** PROMPT E2 TAREA 6 (PROMPTS_CONVERSIA.md:294)

**Detalle:** «recordServiceSend: … costo 0 con fecha de hoy y 0,02 con at posterior al 1-oct» se escribió cuando «hoy» era pre-octubre. Una sesión que lo siga literal con schedule inyectado escribirá un test que falla (hoy ≥ 1-oct → 0,02) o, peor, lo «arreglará» invirtiendo el límite, contradiciendo los casos correctos de E1 TAREA 3 (0 al 2026-09-30T23:59:59Z, 0,02 al 2026-10-01T00:00:00Z).

**Fix:** Reemplazar por fechas fijas inyectadas, nunca relativas: «costo 0 con at = 2026-09-30T23:59:59Z y 0,02 con at ≥ 2026-10-01T00:00:00Z (schedule inyectado)».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H38 [MEDIO] Referencias archivo:línea desfasadas en todo el plan (el ancla «7ddeeb7 del 30-09» es en realidad del 04-09) y la regla «manda el símbolo» vive FUERA de los prompts que se pegan

**Dónde:** Prólogo (PROMPTS_CONVERSIA.md:38-39) y prólogo E (:76-77) vs repo en 9befbe6; anclas verificadas en apps/worker/src/agent-turn.ts, apps/worker/src/workflow-runtime.ts, packages/agents/src/tools.ts:334, apps/api/src/platform/platform.controller.ts:1291-1292, apps/api/src/auth/auth.controller.ts:24

**Detalle:** El plan dice «main del 2026-09-30 (último commit 7ddeeb7)», pero git muestra que 7ddeeb7 es del 2026-09-04 (#378): entre medio hay 15 PRs (#379–#393), no 5, con 34 archivos tocados, varios anclados por el plan. Drift verificado: agent-turn.ts corrido ~+40 líneas en todas sus citas (assembleSystemPrompt :397→:436; creación del message del agente :510-524→:552-566 — sigue siendo el ÚNICO punto de creación del TEXT del agente, como afirma E4; send directo ~:561→:603, ahora DENTRO de un retry loop nuevo MAX_SEND_ATTEMPTS=3 (:598-615) que el plan no conoce; éxito ~:574-585→:616-627; recursión depth<1 :607→:649); workflow-runtime sendTemplate ~:452-466→:387 y sendText :74-101→:66; tools.ts «Agendado por TuBot» ~:271→:334 (getPlanes :537); scheduling NATIVA ~:213→:185; platform.controller computeWhatsappCostUsd :1289-1290→:1291-1292; agents.controller.ts :373/:415→:407/:449. Además F2 TAREA 3 apunta a archivo equivocado: registerSchema vive en auth.controller.ts:24, no en auth.service.ts:33 (ahí está el método register() con firma tipada a mano — la coincidencia de línea hace la referencia doblemente engañosa: el cambio real toca el zod del controller Y la firma/lógica de register() en el service). Lo crítico: la regla «si una línea se movió, manda el símbolo» está en el prólogo, FUERA de los bloques ```text — y los prompts se pegan «tal cual», así que la sesión de VS Code nunca la ve y puede parchear por número de línea en la rama equivocada.

**Fix:** Actualizar ambos prólogos a «referencias al main 9befbe6 (estado real del 2026-09-30)»; corregir la ref de F2 TAREA 3 a «registerSchema (auth.controller.ts:24) acepta vertical opcional y se propaga a register() (auth.service.ts:33), donde se instala el paquete tras crear la org»; actualizar los anclajes listados o agregar la nota «el send del bot está dentro de un retry loop de 3 intentos: chargeServiceSend va ANTES del loop y recordServiceSend dentro de if (sent)»; y agregar UNA línea dentro de cada prompt (en REGLAS): «Las referencias archivo:línea son del commit 9befbe6; si una línea se movió, manda el símbolo/función (grep)».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H39 [MEDIO] F2 cita cargas de seed.ts que no existen (businessHours, vocabulary, modules)

**Dónde:** PROMPT F2 TAREA 1 — packages/database/src/seed.ts y packages/database/seeds/digital-dent.json

**Detalle:** F2 afirma que seed.ts carga «leadStatuses, services, professionals?, tags, agents, workflows, knowledge, businessHours, vocabulary overrides, modules» y pide «extraer de seed.ts las funciones de carga reutilizables». El código lo desmiente en 3 de 10: seed.ts carga organization (settings como blob), clinics, teams, leadStatuses (:118), services (:135), professionals (:153), tags (:183), agents (:192), workflows (:229), knowledge (:263) y channel — NO existe ningún loader de businessHours (va adentro de organization.settings del JSON, p.ej. digital-dent.json:12), ni de vocabulary, ni de modules (eso lo aplica apps/api/src/common/industries.ts en runtime, no el seed). Una sesión que siga F2 va a buscar funciones que no están y puede armar el formato `definition` de vertical_templates incoherente con lo que el instalador realmente puede aplicar.

**Fix:** Corregir la lista en F2: «seed.ts carga clinics/teams/leadStatuses/services/professionals/tags/agents/workflows/knowledge/channel; businessHours viaja dentro de organization.settings; vocabulario y módulos los aplica industries.ts». Y decir explícito que el módulo compartido debe ESCRIBIR instaladores nuevos para businessHours/vocabulary/modules (reusando applyIndustry de industries.ts), no extraerlos de seed.ts.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H40 [MEDIO] F4 pide implementar rescheduleAppointment, método que no existe en el contrato

**Dónde:** PROMPT F4 TAREA 1 — packages/types/src/index.ts:111 y packages/scheduling/src/index.ts:287

**Detalle:** F4 ordena «Implementar en el provider NATIVA: rescheduleAppointment, cancelAppointment, confirmAppointment» y a la vez «Respetar el contrato SchedulingProvider». El contrato no tiene rescheduleAppointment: el método de reagendo es updateAppointment(id, changes) (types :111), y es exactamente el que NativeSchedulingProvider stubbea con notYet() en index.ts:287 (junto a cancelAppointment :288 y confirmAppointment :289). Riesgo real: la sesión agrega un método nuevo al interface (rompiendo los providers Cláriva/Dentalink/custom/mock que F4 prohíbe tocar) o implementa un método paralelo que nadie llama.

**Fix:** En F4 TAREA 1 nombrar los métodos del contrato: updateAppointment (reagendar), cancelAppointment, confirmAppointment. Además resolver la cláusula del no-show: el contrato SÍ lo contempla (markNoShow/markAttendance, types :119-120) — eliminar la alternativa «si no, meta.attendance».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H41 [MEDIO] F7 subestima su migración: support_tickets no tiene columna para el código CV-XXXX

**Dónde:** PROMPT F7 TAREA 2 y tabla de etapas («Migración: sí (1: enum canal WEBCHAT)») vs packages/database/prisma/schema.prisma:427-445

**Detalle:** SupportTicket existe (con routedConversationId, útil para la vinculación) pero NO tiene campo code, y la fila de F7 en la tabla de dependencias cuenta una sola migración (el enum WEBCHAT). El código CV-XXXX debe persistirse e indexarse: se muestra en el widget («Ticket CV-1042»), viaja en el texto prellenado de wa.me y el webhook entrante lo busca para vincular la conversación de WhatsApp al ticket. El «mismo generador de códigos del montaje» (assisted-setup.controller.ts:35-39, TB-XXXX-XXXX) solo es reutilizable como función de string aleatorio: el montaje guarda el código como hash SHA-256 con vencimiento de 30 min (AssistedSetupGrant.redeemCodeHash), patrón que tal cual es incompatible con un código de ticket durable y visible. Una sesión F7 que siga el plan al pie de la letra descubre a mitad de camino que necesita otra alteración de schema no anunciada.

**Fix:** En F7 TAREA 2 y en la tabla de etapas, ampliar la migración a: enum WEBCHAT + columna/campo de código en support_tickets (indexado por org proveedora). Precisar que se reutiliza solo la función generadora de assisted-setup.controller.ts:35-39 y que el webhook entrante resuelve el código dentro de la org proveedora (dueña del número de soporte). El diseño final de almacenamiento (hash + TTL vs claro indexado) debe cerrarse junto con los requisitos de seguridad de H3 — en ambos casos la migración extra existe y la tabla debe declararla.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H42 [MEDIO] Textos y alertas que ve el cliente Conversia: catálogo compartido habla de «cupo de conversaciones» que en Conversia no existe

**Dónde:** PROMPT E3 TAREA 4 y PROMPT E5 TAREA 1 (textos wallet.empty, messaging-guard, conversations.low/limit) vs CONVERSIA_COSTOS.md §0 (sin cupo de conversaciones en Conversia); PROMPT F5 TAREA 1 (no siembra conversationsPerPeriod para los planes conversia)

**Detalle:** E3/E5 escriben en el catálogo compartido y en los gates textos como «cada respuesta descuenta de tu cupo mensual de conversaciones» — correcto para TuBot, falso para Conversia (donde el servicio descuenta créditos y por decisión NO hay cupo comercial de conversaciones). F5 tampoco dice con qué valor sembrar conversationsPerPeriod/conversationHardCap en los planes conversia (¿-1 ilimitado? ¿0 solo medición?), así que un dev podría dejar a clientes conversia recibiendo avisos de un cupo que su contrato no tiene, mezclados con las alertas de créditos al 80% de F5: dos sistemas de alerta con vocabulario contradictorio en la misma bandeja/correo.

**Fix:** En F5: sembrar explícitamente conversationsPerPeriod: -1 (o 0) en los 3 planes conversia con comentario de la decisión, y agregar una tarea corta de textos por marca: los eventos/gates que mencionan «cupo de conversaciones» resuelven su variante vía brandOf(org) (para conversia hablan de créditos). Definir en una línea qué ve el cliente conversia: solo alertas de créditos.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H43 [MEDIO] Verificación de correo en el registro: prerrequisito de Fase 0 sin dueño en todo el plan

**Dónde:** CONVERSIA_VERTICALES.md §5 Fase 0 y CONVERSIA_MONTAJE.md §4 (prerrequisito vigente) vs PROMPTS_CONVERSIA.md (ni Etapa 0 operativa ni E1-E5 ni F1-F10 lo incluyen); apps/api/src/auth/auth.controller.ts (registro por password sin verificación; solo Google llega verificado)

**Detalle:** Ambos documentos fuente declaran «verificación de correo en el registro (antiabuso)» como prerrequisito independiente antes de lanzar con tráfico pagado, y el plan de prompts no lo recoge en ninguna parte (tampoco la auditoría pre-prod lo verifica). Con /registro público en app.conversia.cl + campañas por vertical, el resultado conocido es basura de orgs y correos de bienvenida/notificaciones a direcciones ajenas.

**Fix:** Asignarle dueño: tarea en F3 (registro con verificación por link/código antes de activar la org) o mini-etapa propia previa al lanzamiento; o decisión escrita del dueño de lanzar sin verificación (y agregarla al punto 7 de la auditoría para confirmarla).

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H44 [MEDIO] Acento por usuario: F3 exige persistirlo «en las preferencias del usuario (API)» pero no existe almacenamiento ni endpoint, y F3 declara «sin migración»

**Dónde:** PROMPT F3 (design system, acento configurable) y tabla de etapas (F3: Migración «no»); schema.prisma:340-358 (model User sin campo settings/preferences)

**Detalle:** El modelo User no tiene columna de preferencias y ningún prompt crea el campo ni el endpoint (GET/PATCH). La sesión F3, con «migración: no» en su fila y la regla de no tocar más que billing para el endpoint de resumen, queda sin camino legal: o improvisa (localStorage, contradiciendo la spec «API»), o mete una migración no prevista en una etapa marcada sin migración.

**Fix:** Mover a F1 (que ya migra) una columna User.settings Json @default("{}") + endpoint PATCH /me/preferences (zod: accent dentro de la paleta curada), o autorizar explícitamente en F3 esa migración mínima y el endpoint.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H45 [MEDIO] Breakpoint 980 fantasma: la auditoría lo exige y F3 nunca lo define

**Dónde:** PROMPT DE AUDITORÍA punto 5 («breakpoints 620/980») vs PROMPT F3 (navegación: ≥620 riel / <620 tab bar; bandeja: master-detail «únicamente bajo ~620px», y «solo se compacta la lista» sin número)

**Detalle:** «980» no aparece en ninguna otra parte del plan ni del repo: probablemente viene del artifact de diseño v8, que la sesión F3 no verá como spec numérica. El desarrollador de F3 no sabe que debe existir un segundo breakpoint (¿dónde la lista de chats pasa de completa a compacta?) y el auditor contrastaría contra una cifra sin fuente: hallazgo falso garantizado o layout intermedio indefinido entre 620 y escritorio ancho.

**Fix:** Definir en F3 TAREA 2 pantalla 2: «620–980px: lista de chats compacta (avatar + nombre); >980px: lista completa con preview», o eliminar «980» del punto 5 de la auditoría y dejar solo 620.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H46 [BAJO] F5 TAREA 1 no nombra la key que acredita la bolsa en la renovación: si la sesión inventa «credits», el ciclo no acredita nada

**Dónde:** PROMPT F5 TAREA 1 («créditos mensuales de bolsa (1.500/4.000) acreditados por el ciclo de suscripción existente») vs apps/worker/src/subscription-billing/db-port.ts:109 (planIncludedQuota lee features.templateMessages) y packages/database/src/seed.ts:315-347

**Detalle:** El ciclo existente acredita la bolsa leyendo plan.features.templateMessages (planIncludedQuota en annual-wallet-refill, usado por applySuccess). F5 habla de «créditos» sin nombrar la key; una sesión podría sembrar features.credits (más natural para Conversia) y la renovación acreditaría el WALLET_DEFAULT_QUOTA en vez de 1.500/4.000, sin error visible. Hay además una deuda semántica menor: la key se llama «templateMessages» pero para Conversia representará créditos que (según la decisión de H1) pueden incluir servicio.

**Fix:** Agregar una línea a F5 TAREA 1: «los créditos se siembran en features.templateMessages (es la key que leen planIncludedQuota/annual-wallet-refill y db-port.applySuccess); no crear otra key», con un test de que el ciclo acredita 1.500 al plan conversia_funcionando. Opcional: comentario en seed.ts aclarando que para brand=conversia esa key significa créditos totales.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H47 [BAJO] F10 declara F7 como «ideal» pero su TAREA 4 (contexto total para soporte) es «CRÍTICO» y requiere F7 mergeada

**Dónde:** Tabla fila F10 («F2 mergeada · ideal F5/F7») vs PROMPT F10 TAREA 4 («enlace con F7 — CRÍTICO»: buildClientContext inyectado al prompt del agente de soporte al abrir/retomar un ticket)

**Detalle:** Si F10 corre con F7 pendiente (la tabla lo permite), la TAREA 4 no tiene ticket ni agente de soporte donde inyectar el contexto: la sesión la implementa a ciegas contra interfaces que F7 aún no creó, o la salta — y el criterio de aceptación de F10 («un ticket de soporte muestra al agente el contexto completo») es incumplible. Lo mismo, en menor grado, con «marcar ENTREGADO dispara la activación del ciclo de cobro de F5».

**Fix:** Subir F7 a dependencia dura de la TAREA 4 (o condicionar: «si F7 no está mergeada, deja buildClientContext + tools listos con test y un TODO de cableado en F7») y anotar igual condición para la activación F5 del wizard.

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H48 [BAJO] F8 TAREA 4 habilita tools en el agente del paquete vertical (F2/F6) y menciona la pantalla F3, con dependencia declarada solo F4

**Dónde:** Tabla fila F8 («Depende de: F4 mergeada») vs PROMPT F8 contexto («y también hacerlo desde la pantalla de Ajustes de agenda (F3)») y TAREA 4 («Habilitar las tools en el agente del paquete vertical (F2/F6)»)

**Detalle:** Si F8 corre tras F4 pero antes de F2/F6 no existen agentes de paquete vertical donde habilitar las tools (TAREA 4 queda sin objeto) y la vía por panel depende de F3. Es menor porque las TAREAS 1-3 son autónomas, pero la sesión no sabrá qué hacer con la TAREA 4.

**Fix:** Anotar en la tabla «F4 mergeada (TAREA 4 requiere F2/F6)» y condicionar la TAREA 4: «si F2/F6 no están, deja las tools registradas + test y documenta la habilitación pendiente en el paquete».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H49 [BAJO] E5 TAREA 3 dice «los 7 cambios de la tarea 1», pero la TAREA 1 lista 8 ítems

**Dónde:** PROMPT E5 TAREA 3 («los 7 cambios de la tarea 1 (ruta, texto viejo → nuevo…)») vs TAREA 1 ítems 1-8 (el 8 es el barrido de docblocks/docs internas)

**Detalle:** La sesión podría inventariar solo los ítems 1-7 y dejar el resultado del barrido del ítem 8 (wallet.ts:23, messaging-guard.ts:9-10, PREPAID_WALLET_DESIGN, WHATSAPP.md…) fuera del documento COPY_PENDIENTE_OCT2026.md reescrito, perdiendo la trazabilidad de qué docblock quedó corregido — justo lo que la TAREA 3 existe para registrar.

**Fix:** Reescribir: «los cambios 1-7 con texto exacto antes→después, más la lista de archivos tocados por el barrido del ítem 8 con su estado».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H50 [BAJO] E4 fija «tono de WhatsApp» en el preámbulo no desactivable de TODOS los agentes; F7 lo hereda en el canal web

**Dónde:** PROMPT E4 TAREA 1 (regla 6 en CORE_SCOPE_PREAMBLE: «…en tono de WhatsApp…») y TAREA 2 (maxAgentMessagesPerTurn global) vs PROMPT F7 (mismo orquestador para el agente de soporte del widget)

**Detalle:** La regla 6 se antepone «SIEMPRE a todos los agentes de todos los tenants y no es desactivable»: tras F7, el agente de soporte del webchat opera con una instrucción de canal equivocada, y el tope global de 1 mensaje/turno también gobierna el widget sin que F7 lo mencione. No rompe nada (la fusión de textos es inocua en web), pero es una contradicción de canal que ningún prompt reconoce, y futuras marcas/canales la heredarán.

**Fix:** Redactar la regla 6 neutra de canal («un solo envío por turno, completo; frases cortas está bien») y agregar una línea a F7: «el agente de soporte hereda la regla de 1 mensaje/turno y el tope maxAgentMessagesPerTurn — correcto y deseado».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H51 [BAJO] Soporte de clientes TuBot sin widget: decisión implícita que el plan no escribe

**Dónde:** PROMPT F7 TAREA 3 (widget solo en conversia-web); schema.prisma:423-445 (SupportTicket actual → Super Admin)

**Detalle:** F7 construye el widget únicamente en conversia-web; los clientes TuBot siguen con el «reportar problema» actual (ticket al Super Admin, sin chat IA ni continuidad WhatsApp). Puede ser la decisión correcta, pero no está escrita en ninguna parte: un dev de F7 puede scope-creepear portándolo a apps/web (zona que otras etapas prohíben tocar) y el auditor pre-prod lo levantará como brecha al recorrer el viaje del cliente TuBot.

**Fix:** Una línea en F7 REGLAS: «apps/web (TuBot) NO se toca: sus clientes conservan el mecanismo actual de tickets — decisión consciente; portar el widget a TuBot queda para después». Sumarla a la lista de «Qué queda fuera».

*Verificación adversarial: 1 refutadores, 0 refutan.*

### H52 [BAJO] Tiempos verbales vencidos en los contextos de E1/E2 («hoy son gratis», «costarán», «hoy da 0»)

**Dónde:** PROMPT E1 contexto (líneas 84-86: «que hoy son gratis», «costarán»), E2 contexto (línea 170: «(hoy gratis)») y E2 TAREA 3 (línea 246: «para servicio hoy da 0 y desde el 1-oct dará 0,0200»)

**Detalle:** Los prompts se pegan tal cual en sesiones posteriores al 1-oct: una sesión que lea «hoy son gratis» con fecha de sistema de octubre puede dudar de si el cobro rige, o copiar ese presente falso a docblocks y docs nuevos (el mismo tipo de deuda que E5 limpia). No rompe código, pero siembra incoherencia.

**Fix:** Pasada única de tiempos verbales en E1–E5: «desde el 1-oct-2026 Meta cobra los mensajes de servicio (YA vigente); hasta el 30-09 eran gratis». En E2 TAREA 3: «computeWhatsappCostUsd con schedule sembrado da la tarifa vigente (0,02 CL); sin schedule da 0 — por eso la siembra es el mismo día del deploy».

*Verificación adversarial: 1 refutadores, 0 refutan.*

## Verificado como correcto (sin hallazgo)

Lo siguiente se contrastó contra el código en main 9befbe6 y calza con lo que el plan afirma — ninguna sesión debe re-descubrirlo ni dudar de ello:

- Hipótesis 1 (tabla vs texto) revisada completa: E1-E5 internamente coherentes (E4 paralelo a E3, E5 al final, referencias cruzadas de matriz/docs consistentes); F1/F2/F4/F9 con dependencias bien declaradas; las fallas encontradas (F6, F7, F8, F10) van como hallazgos.
- Piezas que los prompts dan por existentes y SÍ existen en main 9befbe6: SupportTicket (schema.prisma), getClientSetupState / getPlanes / enviarLinkDePago (packages/agents/src/tools.ts), gen-tubot-agents-sql.mjs, scripts/simulate-inbound.mjs, template-guide.ts (en apps/api/src/organizations/, no en apps/web — F6 no da ruta, OK), industries.ts, agenda.controller.ts, catalog.ts, billing-dunning.test.ts / contact-capture.test.ts, digital-dent.json, geoFromPhone (apps/worker/src/phone-geo.ts).
- F3 «compra de sobres»: MessagePackage y POST /billing/buy-package ya existen — F3 puede construir la UI contra el endpoint actual; F5 solo siembra el sobre de 500/$21.900 (no es dependencia dura).
- Los E1-E5 embebidos en PROMPTS_CONVERSIA.md son IDÉNTICOS (diff verificado) a los de PROMPTS_SERVICIO_OCT2026.md — sin drift hoy.
- E5 ítem 7: la frase «Responder dentro de 24 h es GRATIS» existe tal cual en docs/TUBOT_TENANT.md:242 — el inventario de copy calza.
- Convención de features de E3 (0 = solo medición / -1 ilimitado / N cupo) coherente entre TAREA 2, TAREA 4 y los tests de TAREA 6 (el caso «cupo 0 = todo pasa» desambigua el tope duro para TRIAL).
- Nombres cruzados consistentes entre etapas: docs/SERVICE_MESSAGES_TEST_MATRIX.md (E2→E5), features conversationsPerPeriod/conversationOverageClp/conversationHardCap (E3/E5), claves msgcap:svc:*, whatsappRateSchedule (E1/E2/checklist), WEB_URL_CONVERSIA (F1/F3), settings.vertical (F2/F10).
- Las referencias archivo:línea de E1/E2/E5 siguen válidas en main 9befbe6: pricing.ts:151-152 (case service), clp() con service:0, docblock 52-63; wallet.ts :26/:32-48/:55-60/:183-201; messaging-guard.ts :77/:90/:169/:176; inbound.ts :149-178/:184/:193. Los PRs #389-#393 no tocaron los archivos de dinero.
- El mecanismo de link de pago del PR #378 SÍ existe (platform.controller.ts:1565, POST /organizations/:id/payment-link) — el hallazgo es sobre su semántica (activa suscripción), no sobre su existencia.
- La compra de sobres por Flow ya existe de punta a punta: buy-package con prefijo 'pkg:' + webhook idempotente (webhookEvent único) que acredita package_purchase (billing.controller.ts:364-393, :600-613) — buen precedente para el setup fee.
- La renovación acredita la bolsa con carryover cap según el diseño de PREPAID_WALLET_DESIGN §2.4 (db-port.ts applySuccess:108-116) y refundForMessage es idempotente (base de W-2 lista).
- La afirmación N4 de E3 es correcta: wallet.ts planQuota usa organization.planId (wallet.ts:74) mientras plan-limits usa la suscripción — la divergencia existe tal como el plan la describe.
- Las convenciones de features que E2/E3 asumen (templateMessages 0/-1/N, whatsappTemplates boolean) coinciden con el seed actual (seed.ts:315-347) y con quotaFromPlanIncluded.
- El débito de bolsa es atómico e idempotente por messageId como exige el diseño (wallet.ts debitForMessage, UPDATE con balance >= weight), y el fusible devuelve el crédito al cortar tras debitar (messaging-guard.ts:174-177).
- Patrón TB-XXXX verificado sólido y correcto como referencia: código aleatorio (8 chars, alfabeto de 31 sin ambiguos, randomInt), guardado solo como hash SHA-256, un solo uso (se anula al canjear), con expiración, ligado al contacto que canjea y opcionalmente a un canal (assisted-setup.controller.ts:19-40, tool-services.ts:995-1019, migración 20260817200000)
- F8: el doble cerrojo (habilitación por versión de agente + verificación runtime en ToolContext) está bien enunciado y es coherente con la regla 4 de CLAUDE.md; la resolución por 'contacto de la conversación' apunta implícitamente al wa_id autenticado del webhook (el hueco es la verificación del teléfono del usuario, no la fuente del número — ver hallazgo)
- setup.sql: el rol conversia_app NO tiene TRUNCATE sobre ninguna tabla (grant solo S/I/U/D); RLS con FORCE + FK dinámica cubren automáticamente toda tabla nueva CON organization_id (las tablas de E3 y F9 heredan aislamiento sin trabajo extra)
- MFA de plataforma y gestión de sesiones (Redis, revocación) YA implementados en main, con MFA obligatorio en PlatformGuard tras la env SUPER_ADMIN_REQUIRE_MFA — hay mecanismo real que F10 puede reutilizar (el doc SUPER_ADMIN_SECURITY.md está desactualizado al respecto)
- Impersonación Super Admin actual: token 30 min, claim imp trazable, auditada (platform.controller.ts:541-576) — buena base para F10
- Rate limiting reutilizable existe (RateLimitService) y el soporte actual ya lo aplica al crear tickets (support.controller.ts:33-35)
- Superficies de inyección de tenant cerradas y verificadas en MULTITENANCY.md: firma HMAC de Meta, canal mock con token, organization_hint solo interno; verify:isolation corre con el rol real de la app
- F9: el rol de migraciones (DIRECT_DATABASE_URL, admin) no se ve afectado por la revocación al rol de app — migraciones y seeds siguen operando
- F7 REGLAS: la inyección server-side del contexto del ticket ('nunca lo declara el cliente') y la persistencia server-side del hilo están correctamente especificadas
- Anclas archivo:línea que verifiqué aún exactas en 9befbe6: inbound.ts:184 (condición billable) y :193 (computeWhatsappCostUsd), catalog.ts:190 (wallet.empty), messaging-guard.ts:77/:90, wallet-card.tsx:52, workflows/[id]/runs/page.tsx:326, TUBOT_TENANT.md:241-242, conversations.controller.ts :816/:897/:1036, notifications.controller.ts:246, config index.ts :74/:89/:115, schema.prisma Organization :362, pricing.ts docblock :52-63 y case service :151-152, scheduling «aún no disponible» :285
- docs/PROMPTS_SERVICIO_OCT2026.md y docs/COPY_PENDIENTE_OCT2026.md existen — las auto-referencias de E1-E5 no se rompen
- El encabezado del plan SÍ está al día con la fecha: tabla de etapas y nota del 2026-10-01 declaran E1-E5 prerrequisito con el cobro vivo («lo PRIMERO a ejecutar»); lo desfasado son los cuerpos de los prompts y el checklist, no la prioridad declarada
- Textos que usan «desde el 1 de octubre» y siguen siendo correctos después de la fecha (wallet-card nuevo de E5 ítem 2, in-app de E5 TAREA 2, nota de vigencia del ítem 8, contextos de E3/E4/E5): no requieren cambio
- Confirmado en main que E1 no está implementada (no existe WhatsappRateSchedule/getWhatsappRateSchedule ni sección en BILLING.md) — coherente con que el plan deba ejecutarse de inmediato
- Las fechas de decisiones del dueño en la sección F (2026-09-30 y 2026-10-01: brief Nocturna, acento por país, navegación, breakpoint 620px) son registros de decisión, no plazos: sin drift
- Organization.country existe (schema.prisma:367, String @default("CL")) — la premisa de F3 'acento por Organization.country' tiene columna real; lo que falta es su captura en el registro (hallazgo aparte)
- SupportTicket (schema.prisma:427, con routedConversationId pensado para enrutar a bandeja) y CustomerPayment (schema.prisma:1602) existen — las piezas que F7 y F9 declaran reutilizar son reales
- apps/api/src/charging/ existe (charging.controller.ts, getnet-charge.ts) y apps/worker/src/customer-charge.ts + getnet-charge.ts existen — las lecturas previas de F9 apuntan a archivos reales
- El endpoint de compra de sobres ya existe (billing.controller.ts:365 buy-package + creditPackage idempotente) — F5 TAREA 3 es consistente con el código; el hueco es solo el lado UI/retorno/USD (hallazgo 4)
- El patrón de vinculación por código del montaje (AssistedSetupGrant, TB-XXXX con hash y expiración) existe tal como F7 lo describe
- Lemon Squeezy para suscripciones ya está implementado (payment-provider.ts: checkout + verificación HMAC del webhook; selección por moneda) — solo W-3 (compra única USD) sigue pendiente
- ChannelType hoy es WHATSAPP_CLOUD/MOCK/INSTAGRAM/MESSENGER — la migración WEBCHAT de F7 está bien prevista como enum nuevo
- Las demás brechas de 'Qué queda fuera' (offboarding/WABA, permanencia, migración TuBot↔Conversia, status page, DTE) están correctamente clasificadas: mínimo documental definido + verificación explícita del auditor en el punto 8 — la excepción es el MFA del operador (hallazgo)
- El flujo E1→E5 cierra internamente para TuBot: medición (E2), freno (E3), copy (E5) y checklist operativo del dueño con los OK numerados
- outbound.ts: todas las referencias exactas en main — check PENDING :14, rama adjunto :73, rama texto :84, patrón SYSTEM :95-106, integrationEvent template.blocked :108-117, bloque de fallos :133-173, comentario falso de reintentos :173 (confirmado falso: ningún productor define attempts y la Queue no tiene defaultJobOptions)
- inbound.ts: usage_event condicionado a pricing.billable && category exacto en :184; computeWhatsappCostUsd posicional en :193 (compatible con la firma retrocompatible de E1); manejo de statuses failed :149-178; dedupe por findFirst meta.externalId sin índice (el índice de expresión de E3 se justifica)
- wallet.ts: WalletCategory sin 'service' :26; normalizeCategory :55-60 con default silencioso a utility (el bug que E2 describe es real); readWeights :32-48 (cache 60 s, key walletWeights); refundForMessage :183-201 existe, es idempotente (anti-doble-refund :190-192) y su ÚNICO caller es messaging-guard.ts:176, tal como afirma el plan; firstTime/SETNX :12-18; docblock :23; wallet_ledger.category String nullable e índice [organizationId, refType, refId] existen en schema.prisma
- messaging-guard.ts: textos de gratuidad exactos en :77, :90 y :169; docblock :9-10 afirma '(servicio, gratis)'; readGlobalCaps (cache 60 s, keys messagingCapGlobalDay/PerTenantDay, envs MSG_CAP_*), tripFuse (alerta OPS una vez al día) y chargeTemplateSend existen con el contrato descrito; /health/fuse existe en la API
- cost-settings.ts: getWhatsappRatesOverride con cache 60 s y fail-open, patrón replicable tal cual para getWhatsappRateSchedule (que correctamente NO existe aún); clave separada 'whatsappRates' confirmada
- workflow-runtime.ts: nodo send_text en :66-121 (create :74-85, send :97-101) — rango citado ~:74-101 válido; sendTemplate existe (:387) con gate + SYSTEM + integrationEvent
- appointment-responses.ts: acuse de recordatorio exacto en :42-51 (create :42-44, send :51)
- whatsapp-escalation.ts: la afirmación N3 es VERDADERA — :92-96 envía plantilla HSM directo al provider sin chargeTemplateSend, sin débito de bolsa y sin crear Message (el plan ya prevé crear el message si no existe)
- Los 4 orígenes de mensaje de servicio del DATO CLAVE están completos en main: 6 call sites totales de send en el worker = los 4 de servicio + 2 de plantilla (whatsapp-escalation y sendTemplate); messaging-send.ts es solo Messenger/IG (sin plantillas ni rate card WhatsApp)
- exports.ts:121 exacto (link hardcodeado www.tubot.cl — referencia válida para F1); assisted-setup.ts, customer-charge.ts (Flow del tenant) y getnet-charge.ts (Getnet WSSE) existen como los describen F6/F9
- Esquema: usage_events.type es String libre y Subscription.periodStart existe (nullable, como asume resolvePeriodStart de E3); wallet.ts usa organization.planId mientras plan-limits usa la suscripción (divergencia N4 real, como afirma E3)
- E4: agent-turn crea UN solo message TEXT del agente por turno y la recursión depth<1 con presentación del agente receptor es deliberada (:649, :674-681); consumidores workflow-live-sim.ts:219 y reliability-monitor.ts:71 exactos; las 3 .add() de conversations.controller.ts en :816/:897/:1036 exactas
- pricing.ts: firma de computeWhatsappCostUsd es posicional (category, countryIso, overrides?) en :135-139 — agregar opts? es retrocompatible, tal como afirma E1; case "service" existe en :151-152; clp() fija service: 0 (:75-80); WHATSAPP_PRICING tiene fila "default" (:131); el docblock :52-63 afirma «los mensajes de SERVICIO… son GRATIS» (:54-55), exacto lo que E1 manda corregir
- whatsapp-pricing.test.ts: el test «servicio (dentro de la ventana de 24 h) es gratis» está exactamente en :11-13 y hay exactamente 5 tests existentes, como dice E1
- core-guardrails.ts: CORE_SCOPE_PREAMBLE exactamente en :12-21 con 5 reglas numeradas — agregar la regla 6 (E4) calza
- orchestrator.ts: devuelve UN string por turno (OrchestrateResult.reply :45; la auto-continuación por max_tokens concatena en prefix+text :172; return :209-210) — la afirmación de E4 se sostiene
- tools.ts: registro ToolRegistry con validación zod server-side y ToolContext (:85-120), getPlanes en :537 con «TuBot» en la descripción (:539) — confirma la necesidad de brandOf en F1
- catalog.ts: wallet.empty con el texto viejo exactamente en :190; estructura audience/urgency/channels/defaultChannels/lockedChannels/link y soporte de hidden (system.test :219) — los eventos nuevos de E3/E5 calzan con el formato
- seed.ts: bloque PLANS exactamente en :307-349 con 4 planes (free/starter/pro/enterprise); el upsert SÍ actualiza features (:356) como afirma E3; convención templateMessages verificada en código (0 = sin cupo, -1 = ilimitado: wallet.ts quotaFromPlanIncluded :63-68 y annual-wallet-refill.test :40-42)
- packages/database/scripts/gen-tubot-agents-sql.mjs y seed-tubot-agents.sql existen; el script lee los prompts de docs/TUBOT_TENANT.md (§3/§4/§5) y escribe el SQL idempotente, con ORG_ID hardcodeado (:27) — consistente con lo que F6 pide generalizar
- packages/database/seeds/digital-dent.json existe (estructura: organization/clinics/teams/leadStatuses/services/professionals/tags/agents/workflows/knowledge/channel)
- config/src/index.ts: RESEND_FROM «TuBot <no-reply@tubot.cl>» :74 exacto, VAPID_SUBJECT :89 exacto, SUPER_ADMIN_MFA_ISSUER «TuBot.cl» :115 exacto, WEB_URL :34, grant de montaje ASSISTED_SETUP_PROVIDER_ORG_ID en :59 (comentario :57-58 — es UNA env, no varias, pero la referencia calza)
- scheduling/src/index.ts: NativeSchedulingProvider exactamente en :213; notYet() con «aún no está disponible» en :284-289 y los stubs hasta :294, como dice F4; availability.ts existe (con availability.test.ts)
- scripts/simulate-inbound.mjs existe y soporta --phone --text --org (docstring :6)
- Docs citados: PENDIENTES.md con 0-bis (:23) y W-2 (:32); WHATSAPP.md:21 dice «conversaciones de servicio gratuitas» (exacto); PREPAID_WALLET_DESIGN.md:8-11 dice «servicio (24 h) GRATIS» (exacto); TUBOT_TENANT.md: frase «Puede dividir en dos mensajes cortos» exactamente en :125 (§2 :109), «Puedes mandar dos mensajes cortos» en :157, «Responder dentro de 24 h es GRATIS» en :242, §7 montaje asistido en :594; COPY_PENDIENTE_OCT2026.md existe; template-guide.ts (apps/api/src/organizations/) soporta rubros con y sin agenda
- Esquema: wallet_ledger.category String? nullable y el índice [organizationId, refType, refId] existen (schema.prisma :2008, :2016); usage_events.type es String libre (:513); Subscription.periodStart existe nullable (:468) — las bases de E2/E3 sin migración calzan; MessagePackage existe para los sobres de F5 (:2021); geoFromPhone existe y está testeado (apps/worker/src/phone-geo); call sites de computeWhatsappCostUsd confirmados posicionales en inbound.ts:193 y notifications.controller.ts:246 (exactos)
- platform.controller.ts: computeWhatsappCostUsd posicional en :1291-1292 (plan dice ~1289-1290, dentro de tolerancia; firma retrocompatible OK), PATCH organizations/:id/messaging-cap en :1007-1019 (plan :1005-1017, OK; el diff de E3 tarea 5 sí es ~5 líneas de zod + merge de settings.messaging), links de reseteo con 'tubot.cl/login' hardcodeado en :513-517 (coincide con F1), impersonación :547, provisión de demos :734-804 y link de pago :1565 existen; el link de pago es efectivamente el PR #378 (commit 7ddeeb7)
- auth: registerSchema existe (pero en auth.controller.ts:24 — ver hallazgo); POST /auth/register operativo y registro/page.tsx existe como registro autoservicio con ?plan= (agregar ?vertical= es viable)
- plan-limits.ts: getEntitlements usa suscripción ACTIVE/TRIALING más reciente (:27, :44-61) tal como afirma el plan; divergencia N4 CONFIRMADA: wallet.ts planQuota lee organization.planId (apps/worker/src/wallet.ts:74-76) — la advertencia del plan es correcta; la convención '0=sin cupo / -1=ilimitado' de features.templateMessages vs 'limits 0=ilimitado' también calza con el código
- industries.ts: vocabulario + módulo agenda confirmados; NO existe rubro dental ni barberia (hay 'salud' genérico) — agregar ambos en F2 es coherente
- onboarding.controller.ts: checklist real (whatsapp/plantillas/agente/flujo/equipo) derivado del estado del tenant; agregar el paso 'paquete vertical' es viable
- agenda.controller.ts: config global (slotStepMin/bufferMin/minAdvanceMin), recursos con workingHours por día, servicios con duración/precio y citas CRUD existen (lo faltante va en hallazgo ALTO)
- payment-provider.ts: asuntos 'TuBot — Plan X' en :73 (Stripe) y :167 (Flow, bloque 165-170) — referencias exactas para F1
- conversations.controller.ts: exactamente 3 .add() a la cola outbound en :816, :897 y :1036, ninguna con attempts, y la Queue outbound se crea sin defaultJobOptions (queues.ts:27) — el N2 de E2 tarea 5 es cierto; otras colas sí definen attempts, lo que confirma el contraste
- notifications.controller.ts:246: computeWhatsappCostUsd('utility', country) exacto en esa línea, posicional
- apps/api/src/charging/ existe (charging.controller.ts + getnet-charge.ts) y apps/worker/src/customer-charge.ts y getnet-charge.ts también; tool enviarLinkDePago existe en packages/agents/src/tools.ts:548 (regla 4 de F9 OK); SupportTicket (schema.prisma:427) y CustomerPayment (:1602) existen; MessageWallet/WalletLedger/MessagePackage existen (:1989/:2002/:2021)
- Canal: ChannelType es ENUM de Prisma (schema.prisma:39: WHATSAPP_CLOUD/MOCK/INSTAGRAM/MESSENGER, usado en ChannelConnection.type :928) — 'Enum de canal WEBCHAT (migración)' de F7 es correcto
- apps/web: agent-templates.ts BASE_STYLE en :18-21 con el texto exacto que E4 extiende ('2-3 frases, una pregunta a la vez'); workflow-templates.ts con 5 plantillas Dental; industry-templates.ts existe y sin instrucciones multi-mensaje; wallet-card.tsx:52 EXACTO ('Responder dentro de las 24 h no cuesta.'); runs/page.tsx:326 EXACTO ('no descuenta bolsa', rama templateSends===0 donde calza el agregado de E5)
- admin: los 4 textos pendientes de OK de E5 confirmados — calculator/page.tsx:173 y :239 ('servicio dentro de 24 h = gratis' ×2), messaging-limits/page.tsx:104 ('las respuestas dentro de 24 h nunca se tocan'), organizations/[id]/messaging-cap-card.tsx:106 ('Solo afecta plantillas (las que cuestan)'); la calculadora efectivamente no expone ni suma 'service' (N7 correcto)
- SSE de bandeja existe y es reutilizable por F3: GET conversations/stream/updates (:1259, text/event-stream) sobre Redis pub/sub por tenant (realtime.service.ts); selector multi-cuenta existe: GET /auth/organizations (:259) + POST /auth/switch (:267) sobre membresía usuario↔orgs — el supuesto de identidad única de F3 es correcto; barra de operación de F3 cubierta por la API (:id/assign :446, :id/stage :498, :id/agent :1102, takeover/release, send-template)
- F1: modelo Organization en schema.prisma:362 EXACTO y sin columna brand (los 'brand' existentes en :329 y :1359 son de PaymentMethod y catálogo de productos, no chocan); generador TB-XXXX-XXXX del montaje existe (assisted-setup.controller.ts:35-39)

---
*Informe generado por auditoría multi-agente con verificación adversarial. Los ajustes operativos derivados viven en docs/PROMPT_MAESTRO_CONVERSIA.md.*
