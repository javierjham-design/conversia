# PROMPT AJUSTES B — Bloque funcional de conversia-web (B1–B8)

Planner, 2026-10-04. Verificado contra producción (org sandbox cmus94hyy…, API
Railway) y origin/main `2b6b61d`. **Un PR por sub-bloque**, CI verde, sin regresión
TuBot. Rigen prompt maestro y auditoría si chocan. Paridad = funcional con TuBot
(`apps/web`), piel = Nocturna (`CONVERSIA_DISENO.md` §6) y cero emojis-ícono.

**Verificado YA CORRECTO (no tocar, solo no romper):** R1-A en prod — Hoy completa,
"Barbero demo" con workingHours sembrado, `/billing/wallet` de org conversia muestra
SOLO el sobre-500, snippets de ejemplo sembrados con `{{contact.firstName}}`. R2 en
prod (configurador de agentes en consola #434). Endpoints B listos:
`GET /conversations/:id/context`, `POST /conversations/:id/assign|stage|agent`,
`GET /inbox/snippets`.

**Brechas NUEVAS detectadas en la verificación (incorporarlas donde se indica):**
- N1 → B4/B1: `GET /agenda/appointments` devuelve `professionalName: null` y
  `serviceName: null` (no hace join). La UI de agenda/Hoy/ficha necesita los
  nombres: incluirlos en el payload.
- N2 → seeds sandbox: las "3 citas de hoy" quedaron fijas al 2026-10-03 — el seed
  sandbox debe crear citas RELATIVAS a "hoy" (para que la demo siempre tenga
  contenido vigente) y el rango por defecto de `/agenda/appointments` debe partir
  en el inicio del día local del negocio (hoy parte en "ahora": una cita de las
  09:00 ya no aparece a las 10:00).
- N3 → B1: el payload de la lista de conversaciones no trae el agente IA activo ni
  el asignado — exponerlos para pintar chips sin N+1.

---

## PROMPT B1 — Barra de operación del chat

```text
Contexto: conversaciones/page.tsx tiene indicador 24h, tomar control y notas; faltan
los chips de operación (brief DISEÑO §6 + maqueta v11). Endpoints ya existen.
TAREAS
1. Barra sobre el hilo (desktop) / sheet "Gestionar" (móvil <620) con:
   · Chip "Agente: {nombre} ▾" → lista agentes PUBLICADOS del tenant
     (GET /organizations/me/agents) → POST /conversations/:id/agent. Muestra el
     activo real (resolver N3: exponer activeAgent en la lista/contexto).
   · Chip "Asignada a: {miembro|—} ▾" → usuarios del tenant → POST :id/assign
     (con "Sin asignar"). Notificación al asignado (catálogo existente).
   · Chip "Etapa: {etapa} ▾" → etapas del tenant → POST :id/stage.
   · Chip "+ Etiqueta" → tags del tenant con crear-nueva → (endpoint de tags de
     contacto existente; si falta uno por conversación/contacto, agregarlo fino).
   · Mover aquí la píldora 24h existente y RE-ESTILARLA: punto de color + candado
     SVG (lucide), píldora ok/warn — sin 🟢/🔒 (regla cero emoji-ícono).
2. Los chips reflejan estado real al abrir (GET :id/context) y actualizan
   optimista con rollback en error.
PARIDAD TuBot: inbox/page.tsx+sidebar muestran asignado/etapa en la lista — añadir
en la lista de chats de conversia-web el mini-indicador de asignado (avatar inicial)
cuando exista.
ACEPTACIÓN (sandbox): en un chat de la org sandbox cambiar agente (Recepción),
asignarse la conversación, mover etapa a "Agendado" y etiquetar "VIP"; recargar y
persiste; auditoría/eventos correctos; móvil: sheet Gestionar operativo.
```

## PROMPT B2 — Acciones del redactor

```text
Contexto: composer actual = texto + adjuntar + nota interna. Paridad con
apps/web/inbox/composer.tsx (snippets con atajo, plantillas) + extras del brief.
TAREAS
1. Respuestas rápidas: botón rayo + atajo "/" al inicio del input → popover
   buscable de GET /inbox/snippets; inserta con variables resueltas
   ({{contact.firstName}} → nombre real) como TuBot.
2. Agendar desde el chat: botón calendario → modal con servicio, profesional
   (GET /agenda/professionals — nombres reales), disponibilidad
   (GET /agenda/availability) y confirmación; crea la cita ligada al contacto y
   deja la tarjeta de evento en el hilo ("Agendado: {servicio} · {fecha} · {prof}").
3. Enviar link de pago: botón $ → modal monto+concepto (+ vínculo a cita opcional)
   → charging existente; el link se inserta como mensaje y evento en el hilo.
4. Fuera de ventana 24h: los botones que envían texto quedan deshabilitados con
   tooltip y CTA a plantilla (modal de plantilla ya existe en new-message).
ACEPTACIÓN (sandbox): "/desp" inserta la despedida con el nombre del contacto;
agendar una cita de "Corte de pelo" con Barbero demo para hoy desde el chat (queda
en /agenda y en el Hoy); generar link de pago de $10.000 (aparece en el hilo y,
pagado-simulado, en caja como conciliado).
```

## PROMPT B3 — Ficha del cliente ("Ver ficha")

```text
Contexto: botón existe sin panel. Base: GET /conversations/:id/context. Paridad:
apps/web/inbox/contact-panel.tsx (stage/tags) — superarla con lo del brief.
TAREAS: panel lateral desktop (≈300px, colapsable) / sheet móvil con: identidad
(avatar, nombre editable, teléfono con copiar, canal) · etapa y etiquetas
(editables — mismas mutaciones de B1) · próxima cita + últimas 3 (con nombres, N1)
y acceso "agendar" (modal B2) · historial de pagos del contacto (CustomerPayment)
con total histórico · campos personalizados del vertical · notas del CONTACTO
persistentes (distintas de las notas del hilo) · accesos: ver en /clientes,
bloquear.
ACEPTACIÓN (sandbox): abrir ficha de Camila Rojas desde su chat → se ve su cita
del seed (con nombre de servicio y profesional), editar etapa/etiqueta desde la
ficha, agregar nota de contacto y verla también en /clientes.
```

## PROMPT B4 — Agenda vista día/semana con línea AHORA

```text
Contexto: hoy lista 30 días; reagendar/cancelar/confirmar ya operan (F4). Paridad:
apps/web/agenda/page.tsx ya tiene day/week con slots — portar el patrón a la piel
Nocturna, no reinventar.
TAREAS
1. Vistas Día (default) y Semana: columnas por profesional/recurso (nombres reales
   — corregir N1 en la API: payload con professionalName/serviceName), bloques por
   cita con estado (ok/warn/cancelada), horario laboral sombreado según
   workingHours, LÍNEA "AHORA · hh:mm" en el acento posicionada por hora local del
   negocio (solo en el día actual), citas pasadas atenuadas.
2. Crear cita tocando un hueco (modal B2 reutilizado, prellenando hora/prof).
3. Acciones sobre la cita (sheet/popover): confirmar, reagendar (slots
   disponibles), cancelar con aviso — ya existentes, solo conectarlas aquí.
4. Rango por defecto del endpoint: desde el INICIO del día local (N2), y mantener
   la lista actual como tercera vista "Próximas".
5. Seed sandbox: citas relativas a hoy (N2) para demo siempre viva.
ACEPTACIÓN (sandbox): la vista Día muestra las citas de HOY con nombres, la línea
AHORA entre medio, crear una cita en un hueco de Barbero demo, moverla y
cancelarla; la semana pinta los 7 días; móvil usable (scroll horizontal por
profesional o selector).
```

## PROMPT B5 — Clientes: etapa, etiquetas, filtro y ficha

```text
Contexto: lista básica con stage:null. Paridad base: apps/web/contacts (lista +
drawer); el kanban board-view y el import CSV de TuBot QUEDAN FUERA de este PR
(anotarlos como B5-v2).
TAREAS
1. Instalador vertical: los contactos creados por seeds/paquete reciben etapa
   inicial "Nuevo" (y los que lleguen por WhatsApp también — verificar el default
   en el flujo inbound para orgs con etapas del paquete).
2. Lista con columna/err chip de etapa y etiquetas, filtro por etapa (pills) y
   búsqueda existente; contador por etapa arriba (mini-embudo textual).
3. Ficha del contacto = REUTILIZAR el panel de B3 como drawer desde la lista.
4. Backfill sandbox: asignar "Nuevo"/etapas variadas a los 4 contactos seed.
ACEPTACIÓN (sandbox): /clientes muestra 4 contactos con etapas visibles, filtrar
por "Agendado" deja los correctos, abrir drawer de un contacto permite editar
etapa/etiquetas/nota y coincide con lo visto desde el chat (B3).
```

## PROMPT B6 — Ciclo de vida Conversia sin trial autoservicio + gate de entrega

```text
Contexto: la org sandbox quedó TRIAL 7+7 con purga programada y deliveredAt con
setupPaid:false — exactamente lo que el plan F5 prohíbe para conversia.
TAREAS
1. Alta brand=conversia (registro público y wizard de consola): estado
   "PENDIENTE_IMPLEMENTACION" (nuevo estado o settings.lifecycle), SIN trial 7+7 ni
   purga de trial; el bot/canales pueden probarse internamente pero el ciclo de
   cobro NO corre.
2. Gate de entrega: "Marcar ENTREGADO" exige setupPaid=true; si no, exige override
   explícito del super admin con motivo → audit log. Al entregar: suscripción
   activa su periodo (primer cobro) y el checklist pasa a GO-LIVE.
3. Vía demo/sandbox explícita: flag settings.lifecycle.demo=true (solo
   plataforma) exime de cobro/purga y se muestra como badge "DEMO" en consola y
   panel; migrar la org sandbox actual a demo=true y QUITARLE la purga programada.
4. trial-lifecycle/retention-purge: excluir orgs conversia (salvo demo con regla
   propia de limpieza manual) — test de que la purga jamás toca una org conversia
   pagada o pendiente.
ACEPTACIÓN: crear org conversia de prueba → sin trial ni purga, no cobra;
marcarla entregada sin setup → bloquea; override auditado → entrega y agenda primer
cobro; org sandbox queda demo=true sin purgeAt; orgs tubot sin cambios (regresión).
```

## PROMPT B7 — Política de verificación de correo

```text
Contexto: emailVerified:false no bloquea login (verificado en sandbox).
TAREAS: para brand=conversia — altas creadas por la CONSOLA/wizard o invitación del
equipo nacen emailVerified=true (el equipo responde por ellas); REGISTRO PÚBLICO
exige verificación antes del primer login útil (pantalla /verify ya existe:
bloquear sesión plena hasta verificar, con reenvío). Para tubot: mantener la
política vigente (no endurecer en este PR; solo documentarla en SECURITY_STATUS).
Invitaciones (accept-invite) verifican implícitamente. Tests por marca y por vía
de alta. Sandbox: marcar verificadas las dos cuentas sandbox.
ACEPTACIÓN: registro público conversia nuevo no opera sin verificar (y sí tras
verificar); alta por consola opera de inmediato; login sandbox intacto.
```

## PROMPT B8 — api.conversia.cl

```text
Contexto: el frontend apunta al dominio Railway; CORS ya es multi-marca.
TAREAS: (1) dejar TODO el código/config listo para API_URL por dominio propio:
NEXT_PUBLIC_API_URL=https://api.conversia.cl en el servicio conversia-web,
brands.ts/links/retornos de Flow y webhooks revisados para no hardcodear el host
Railway (grep y corrección), docs/DEPLOYMENT.md con el paso a paso Railway
(custom domain en el servicio api + verificación TLS) y el registro DNS exacto
que debe crear el dueño (CNAME api.conversia.cl → dominio del servicio). (2) NO
cortar nada: el host Railway sigue válido (CORS acepta ambos) hasta confirmar el
switch. ENTREGA: checklist de 3 pasos para el dueño (DNS → verificar → cambiar la
env y redeploy) + prueba curl de /health por el dominio nuevo cuando esté.
ACEPTACIÓN: con el DNS creado, /health responde por api.conversia.cl, login del
sandbox funciona con la nueva base y nada de TuBot cambia.
```

---

## Orden sugerido y dependencias
B1 → B2 → B3 (comparten contexto del chat; B3 reutiliza mutaciones de B1 y modal de
B2) → B5 (reutiliza ficha B3) → B4 (independiente; incluye N1/N2 de API — puede ir
en paralelo a B1–B3) → B6 → B7 (tocan ciclo de vida/auth; después de lo visual para
no bloquear demos) → B8 (coordinación DNS con el dueño, cualquier momento).

## Entrega por sub-bloque
Archivos tocados · criterios de aceptación ejecutados EN LA ORG SANDBOX con
evidencia (respuestas de API o estado visible) · confirmación sin regresión TuBot
(typecheck + smoke de inbox/agenda/contacts de apps/web) · brechas nuevas que
aparezcan, listadas al final para el siguiente R.
