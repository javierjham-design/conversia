# HANDOFF AL PLANNER — Bloque B (funcional) de Conversia

**Fecha:** 2026-10-04 · **Para:** sesión del planner (recorrido + spec "PROMPT AJUSTES B").
**Objetivo:** que recorras el sandbox EN VIVO, verifiques el estado actual y entregues el **PROMPT AJUSTES del Bloque B** (mismo formato que R1/R2: por sub-bloque, con criterios de aceptación en el sandbox, paridad TuBot donde aplique y design system Conversia). Rigen el prompt maestro + `docs/CONVERSIA_DISENO.md` + los ajustes de auditoría si chocan.

---

## 0. Estado ya EN PRODUCCIÓN (no re-especificar; verificar que sigue bien)

- **R1 Bloque A (#433):** pantalla **Hoy** completa (topbar + "Asistente activo", 4 KPIs, agenda del día con línea AHORA, "Te esperan", anillo de créditos SVG + sobre-500); instalador siembra **recursos de ejemplo**; **marca en sobres** (una org ve solo los suyos); **pesos de bolsa por marca** (incluye `service`).
- **R2 (#434):** **configurador COMPLETO de agentes IA** en la consola (`/admin/organizations/[id]/agents` + `/[agentId]`), paridad TuBot (prompt+variables+plantillas, 15 acciones con "cuándo/cómo", agendamiento, conocimiento, transferencias, **probador en vivo**, borrador→publicar, historial, activar/default canal). El cliente sigue **sin** configurar agentes.
- **Diseño:** tokens claro/oscuro + 6 acentos exactos al brief, acento persistido, PWA, fuentes Fraunces/Inter, luz ambiental. Consola super admin reordenada (grupos) + 9 páginas de config.
- **Caja F9, super admin F10, soporte F7, agenda nativa F4 (incl. cancelar/reagendar por chat)** operativos.

---

## 1. Accesos al SANDBOX (prod — probar aquí)

**Org:** "Barbería Demo Sandbox" (id `cmus94hyy0000l601w4xhl49b`, rubro barbería, brand conversia). Poblada: plan activo, 1.500 créditos, 4 contactos, 3 asientos de caja, 1 profesional "Barbero demo", 3 citas de hoy.

**TENANT (panel del cliente):** https://app.conversia.cl/login · `sandbox.user@conversia.cl` / `SandboxUser-2026` · sin MFA.

**SUPER ADMIN (consola):** https://app.conversia.cl/admin/login · `sandbox.admin@conversia.cl` / `SandboxAdmin-2026` · MFA secreto `DXIKWAV25YVRUR2WCJPAFCCVMAOOROBU` (base32; agrégalo a una app TOTP o genera el código con la lib). ⚠️ Cuenta sandbox temporal (se eliminará al terminar las pruebas).

**API:** `https://api-production-cf8e.up.railway.app` (sin prefijo; 401 = ruta viva).

---

## 2. Bloque B — alcance, ESTADO ACTUAL y referencias (esto es lo que falta)

Para cada ítem te doy: **qué hay hoy**, **qué falta**, **endpoints/archivos** y **referencia de paridad**. Recórrelo en el sandbox y especifícalo fino.

### B1 — Barra de operación del chat (apps/conversia-web/src/app/conversaciones/page.tsx)
- **Hoy:** el hilo tiene indicador de ventana 24h, Tomar control / Devolver a IA, cerrar/reabrir, notas internas, adjuntos, SSE en vivo.
- **Falta (brief §6 + F3):** chips **Agente IA ▾** (cambiar el agente que atiende), **Asignada a ▾** (derivar a un miembro/equipo), **Etapa ▾** (updateLeadStatus), **+ Etiqueta**; mover la píldora 24h a esa barra.
- **API disponible:** `POST /conversations/:id/agent {agentId}` (cambiar agente; agentes de `GET /agents/assignable`), `POST /conversations/:id/assign` (usuario/equipo; `GET /users/assignable`, `GET /users/teams`), `POST /conversations/:id/stage` (etapa; etapas de `GET /conversations/:id/context`), tags del contacto (ver controller de contactos/tags). `GET /conversations/:id/context` ya trae stage/tags/contacto.
- **Paridad:** la barra de operación del editor/bandeja de TuBot (apps/web inbox).

### B2 — Acciones del redactor (composer)
- **Hoy:** texto libre + adjuntar.
- **Falta:** **respuestas rápidas** (`GET /inbox/snippets` ya existe), **agendar cita desde el chat** (modal con disponibilidad de la agenda nativa, prellenando el contacto), **enviar link de pago** (charging existente).
- **API:** snippets `/inbox/snippets`; agenda `GET /agenda/appointments` + disponibilidad + `createAppointment`; cobros (charging) `enviarLinkDePago`/endpoints de CustomerPayment.

### B3 — Ficha del cliente bajo demanda ("Ver ficha")
- **Hoy:** no hay panel lateral; `GET /conversations/:id/context` ya devuelve contacto, etapa, etiquetas, notas IA, origen (ad/lead form).
- **Falta:** panel lateral con teléfono, etiquetas, etapa, **próxima cita + historial de citas/pagos** y **notas persistentes del contacto**.
- **API:** `/conversations/:id/context` + agenda del contacto + pagos del contacto (ver controllers de agenda y charging/contactos).

### B4 — Agenda vista DÍA/semana (apps/conversia-web/src/app/agenda/page.tsx)
- **Hoy:** lista de 30 días.
- **Falta:** **vista día (default) y semana**, con línea "AHORA", citas por profesional/recurso, crear/mover; mantener la lista como vista alterna. (Reagendar/cancelar ya existen — F4/A12.)
- **API:** `GET /agenda/appointments?from=&to=`, `GET /agenda/professionals`, disponibilidad, createAppointment/updateAppointment.

### B5 — Clientes (apps/conversia-web/src/app/clientes/page.tsx)
- **Hoy:** lista básica; en el sandbox los contactos muestran `stage:null`.
- **Falta:** lista con **etapa + etiquetas visibles**, **filtro por etapa**, y **ficha del contacto** (reusar B3). Además: el paquete/instalador debe asignar **etapa inicial "Nuevo"** a los contactos creados (hoy quedan sin etapa).
- **API:** `GET /contacts` (+ filtros), lead statuses, tags.

### B6 — Ciclo de vida Conversia sin trial autoservicio (plan F5)
- **Hoy:** el registro crea trial 7+7 de TuBot con purga; `markDelivered` exige setup pagado y escribe la permanencia (F-1); el gate de entrega existe.
- **Falta (para brand=conversia):** el alta deja la org **"pendiente de implementación"** (sin el trial 7+7 de TuBot); el ciclo de cobro **parte al marcar ENTREGADO**; NO se puede entregar sin setup pagado salvo **override auditado** del super admin (el semáforo ya existe). Mantener una vía **"demo/sandbox"** explícita para cuentas internas.
- **Archivos:** `apps/api/src/auth/auth.service.ts` (register), `apps/worker/src/trial-lifecycle.ts` (ya exenta conversia), `platform.controller markDelivered`.

### B7 — Verificación de correo
- **Hoy:** `emailVerified:false` NO bloqueó el login; el registro conversia sí envía el correo (D6).
- **Falta:** definir y aplicar la política antiabuso: si el alta la hace el **equipo/wizard** → marcar verificado al crear; si es **registro público** → exigir verificación. Decidir el gate (qué se bloquea sin verificar).
- **Archivos:** `auth.service.ts` / `auth.controller.ts` (register, me, verify-email), AppShell banner de verificación.

### B8 — `api.conversia.cl` (subdominio de API)
- **Hoy:** el front apunta al dominio Railway (`api-production-cf8e.up.railway.app` vía `NEXT_PUBLIC_API_URL`).
- **Falta:** configurar el subdominio de API (DNS + Railway + CORS/links por marca) y mover `NEXT_PUBLIC_API_URL`. **El DNS lo coordina el dueño**; dejar el código listo (CORS ya es multi-marca).

---

## 3. Qué debes entregar (planner)
Un **PROMPT AJUSTES B** en el mismo formato que R1/R2:
- Sub-bloques (B1…B8) priorizados; nota de **paridad TuBot** y **diseño Nocturna** (`CONVERSIA_DISENO.md` §6 para Conversaciones).
- **Criterios de aceptación en el sandbox** (p. ej.: "en una conversación del sandbox, cambiar el agente con el chip y verificar que atiende el nuevo; abrir Ver ficha y ver la próxima cita de hoy").
- Marca lo que ya esté correcto (no re-especificar) y cualquier **brecha nueva** que descubras.
- "Un PR por sub-bloque o como indique el prompt maestro; CI verde; sin regresión TuBot."

---

## 4. Referencias
- Diseño canónico: `docs/CONVERSIA_DISENO.md` (§5 navegación, §6 pantalla **Conversaciones** con la barra de operación completa).
- Paridad funcional: la bandeja/inbox + agenda + contactos de TuBot en `apps/web/src/app/(app)/`.
- API del tenant: `apps/api/src/conversations/conversations.controller.ts`, `apps/api/src/agenda/*`, contactos, `apps/api/src/organizations/*` (inbox/snippets).
- Informe de auditoría previa: `docs/AUDITORIA_PREPROD_CONVERSIA.md`.
