# PROMPT AJUSTES R1 — Recorrido sandbox del 2026-10-03 (funcional + diseño)

Resultado del recorrido completo de la plataforma viva (app.conversia.cl, cuentas
sandbox tenant y super admin, vía API + código de origin/main `3639374`). Se pega tal
cual en la sesión de desarrollo. Rigen el prompt maestro y los ajustes de auditoría si
chocan. Un PR por bloque (A, B, C) o como indique el prompt maestro; CI verde.

Lo que YA está correcto y NO se toca (verificado en vivo): tokens de ambos modos y 6
acentos exactos a CONVERSIA_DISENO.md · acento por usuario con persistencia en
servidor + default por país (registro y brands.ts) · saludo según hora con zona
horaria · semáforo de créditos por tramos · riel/tab bar con corte en 620px ·
master-detail móvil del chat · indicador de ventana 24h · notas internas · IA
activa/Tomar control · SupportWidget con ticket CV-XXXX, wa.me y persistencia ·
caja F9 (day con conciliado/declarado, egresos) · consola admin (semáforo de
implementación, client-context, márgenes, verticals con wave/status/variant) ·
planes Conversia y sobre-500 a $21.900 · login por marca vía Origin (D8).

Contexto de verificación sandbox usado: org `Barbería Demo Sandbox`
(cmus94hyy0000l601w4xhl49b, brand conversia, vertical barberia v3), API
https://api-production-cf8e.up.railway.app.

---

## BLOQUE A — BLOQUEANTES de demo/venta (primero)

A1. **La pantalla "Hoy" es un stub** (apps/conversia-web/src/app/page.tsx, 112
líneas: tres tarjetas con texto placeholder). Implementarla COMPLETA según
CONVERSIA_DISENO.md §6 y la maqueta v11 — los datos YA existen en la API:
- Topbar: fecha+hora · indicador "Asistente activo" con pulso (estado real: hay
  agente activo y canal conectado; si no, "Asistente en preparación") · campana de
  notificaciones · avatar del usuario. Botón primario "+ Nueva cita".
- 4 KPIs de vidrio: Citas hoy (GET /agenda/appointments filtrado al día, con
  huecos libres si la config da horario) · Por confirmar (status de citas, color
  warn) · Caja del día (GET /cash/day → summary.net, con mini-sparkline de los
  últimos 7 días vía /cash/report) · Atendió tu asistente (conversaciones del día).
- Agenda del día: lista de citas con riel del acento, pasadas atenuadas (op. .55),
  línea "AHORA · hh:mm" posicionada entre citas, estado ok/warn por pill. Enlace
  "Ver semana →" a /agenda.
- "Te esperan": conversaciones PENDING/derivadas reales (GET /inbox) con avatar,
  último mensaje y hace-cuánto; enlace a /conversaciones.
- Créditos: ANILLO SVG semántico (gradiente ok→warn→danger, dasharray por pctUsed,
  % al centro coloreado por tramo — hoy es solo un número), texto "X de Y usados",
  proyección, y botón "Comprar sobre +500 · $21.900" (flujo de compra existente).

A2. **El paquete vertical no siembra profesionales/recursos de ejemplo**: en la org
sandbox, GET /agenda/professionals = [] → no se puede agendar NI demostrar la
agenda. En las vertical_templates (todas las de citas), sembrar 1–2 recursos de
ejemplo según el rubro (barbería: "Silla 1 — Barbero demo"; dental: "Box 1 — Dr.
Demo"...), con horario típico del catálogo CONVERSIA_RUBROS.md, marcados
`isExample: true` en meta para que la consola los muestre como "reemplazar en
implementación". Verificar que el Hoy/A1 y la agenda quedan con contenido al
instalar un paquete.

A3. **Agente y flujo instalados quedan sin versión visible**: GET
/organizations/me/agents → versions: [], currentVersionId: null (ídem workflow
"Bienvenida"). El instalador (vertical.service.ts, publish:false) debe dejar SIEMPRE
una VERSIÓN BORRADOR con el prompt/definición del rubro; si la crea y el endpoint
solo lista publicadas, exponer el borrador (flag draft) para que panel/consola lo
muestren. Criterio: tras instalar un paquete, la consola F10 puede abrir el agente,
ver el prompt del rubro en borrador, probarlo y publicarlo (paso GO-LIVE).

A4. **Fuga de marca en paquetes de bolsa**: GET /billing/wallet para una org
conversia devuelve los packs TuBot (msgs_1000 $29.900, msgs_5000 $129.900) junto al
sobre-500. COSTOS §0 define UN solo excedente para Conversia (sobre 500 · $21.900) y
además revela pricing de la otra marca. Agregar `brand` (o allowlist por marca/plan)
a MessagePackage y filtrar en el endpoint y en la UI de compra. TuBot no debe ver el
sobre-500 tampoco. Test de regresión por marca.

A5. **Débito de servicio y pesos por marca (F5-B / H2) — verificar y cerrar**: GET
/platform/wallet-weights = {utility:1, authentication:1, marketing:4} — sin clave
`service` y aparentemente global. Confirmar que para orgs brand=conversia el débito
de créditos por mensaje de servicio (sobre las 1.000 gratis/mes por número de Meta)
está OPERATIVO con peso 1, que la clave de pesos es POR MARCA (sembrar 1/1/1/4 en
conversia no debe alterar débitos de TuBot), y que el endpoint/panel del super admin
expone y edita los pesos por marca incluyendo service. Tests: envío de servicio en
org conversia debita 1 crédito tras agotar free tier; org tubot sin cambios.

## BLOQUE B — Funcional (completar lo planificado)

B1. **Barra de operación del chat** (conversaciones/page.tsx): faltan los chips del
brief (PROMPTS_CONVERSIA F3 y DISEÑO §6): **Agente: {nombre} ▾** (ver qué agente IA
atiende la conversación y cambiarlo entre los publicados del tenant) · **Asignada a:
{miembro} ▾** (derivar a un usuario del equipo, con notificación) · **Etapa ▾**
(updateLeadStatus) · **+ Etiqueta**. La píldora de ventana 24h ya existe: moverla a
esta barra y quitarle los emojis (ver C2).

B2. **Acciones del redactor**: agregar respuestas rápidas (GET /inbox/snippets ya
existe) · **agendar cita desde el chat** (modal con availability de la agenda
nativa, prellenando el contacto) · **enviar link de pago** (charging existente).
Adjuntar ya está.

B3. **Ficha del cliente bajo demanda** en el chat ("Ver ficha"): panel lateral con
teléfono, etiquetas, etapa, próxima cita, historial de citas/pagos y notas
persistentes del contacto.

B4. **Agenda: vista de DÍA** (agenda/page.tsx hoy es una lista de 30 días): vista
día (default) y semana, con línea "AHORA", citas por profesional/recurso, crear/
mover; mantener la lista como vista alternativa. Reagendar/cancelar ya existen (F4).

B5. **Clientes** (105 líneas): completar el mínimo del brief — lista con etapa y
etiquetas visibles (el sandbox muestra stage:null → el paquete debe asignar etapa
inicial "Nuevo" a contactos creados), filtro por etapa, y ficha del contacto
(reutilizar B3).

B6. **Ciclo de vida Conversia sin trial autoservicio** (plan F5): la org sandbox
quedó TRIAL 7+7 con purga, suscripción ACTIVE y deliveredAt seteado con
setupPaid:false. Para brand=conversia: el registro/alta deja la org "pendiente de
implementación" (sin trial 7+7 de TuBot), el ciclo de cobro parte al marcar
ENTREGADO, y NO se puede marcar entregado sin setup pagado salvo override explícito
y auditado del super admin (la consola debe mostrar ese gate — el semáforo ya
existe). Mantener una vía "demo/sandbox" explícita para cuentas internas.

B7. **Verificación de correo**: emailVerified:false no bloqueó el login. Confirmar
la política antiabuso para conversia (si el alta es por el equipo/wizard, marcar
verificado al crearla; si es registro público, exigir verificación) y aplicarla.

B8. **api.conversia.cl**: el frontend apunta al dominio Railway. Configurar el
subdominio de API (DNS + Railway + CORS/links por marca) y mover
NEXT_PUBLIC_API_URL — mejora branding, cookies y portabilidad. (Coordinar con el
dueño el DNS; dejar el código listo.)

## BLOQUE C — Diseño (afinado contra la maqueta v11)

C1. **Anillo de créditos** (A1) y **sparkline de caja**: usar los SVG del brief
(DISEÑO §4/§6), nunca el acento del usuario para el arco.
C2. **Cero emojis como íconos** (regla del design system): la píldora 24h usa 🟢/🔒
→ punto de color + candado SVG (lucide) dentro de una píldora ok/warn como la
maqueta. Barrer otros emojis-ícono en conversia-web (los emojis en TEXTO de chat
están bien).
C3. **Luz ambiental**: si los blobs decorativos del fondo (2–3, blur 80px, color del
acento, deriva 16–24s, off con prefers-reduced-motion) no están en el shell,
agregarlos en Hoy y login al menos (son parte del "wow" nocturno del brief);
mantenerlos sutiles y solo CSS.
C4. **Riel**: hoy tiene 8 ítems (Hoy, Conversaciones, Agenda, Clientes, Caja,
Canales, Cobros, Ajustes). Propuesta para igualar la jerarquía del brief sin perder
nada: principales = Hoy, Conversaciones, Agenda, Clientes, Cobros; y Caja/Canales/
Ajustes al grupo inferior del riel (como ya hace el "Más" móvil) — o fusionar
Caja+Cobros bajo "Cobros" con pestañas. Elegir una y aplicarla coherente en riel y
tab bar.
C5. **Tipografía display**: verificar Fraunces en saludo del Hoy, títulos de
pantalla y cifras grandes (clase .display ya existe — aplicarla donde falte, p. ej.
el monto de créditos del Hoy nuevo).

## ENTREGA
Por bloque: archivos tocados y endpoints usados · captura de criterios de
aceptación: (A1) el Hoy del sandbox muestra citas/caja/te-esperan/anillo con los
datos reales de la org sandbox; (A2–A3) instalar un paquete en org nueva deja
agenda demostrable y agente en borrador visible/publicable; (A4) org conversia ve
SOLO el sobre-500 y org tubot no lo ve; (A5) test de débito de servicio por marca
en verde; (B1–B3) chips y acciones operativas contra la API; (B6) org conversia
nueva sin trial y gate de entrega activo · typecheck + tests en verde · sin
regresiones TuBot (grep de marca + smoke).
