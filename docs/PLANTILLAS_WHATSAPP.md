# Plantillas WhatsApp de agendamiento (Digital Dent)

Las **4 plantillas HSM** que usan los flujos de agendamiento/recaptura. Cuerpos,
variables (mapeo posicional → campo semántico) y botones quick-reply. Todas en
español (`es`). El mapeo se guarda en `channel_connection.config.templateMappings`
al crearlas (lo usa `resolveTemplateParams` al enviar) y se refleja en
`whatsapp_templates.body.variableFields` al sincronizar desde Meta.

**Mapeo posicional (común):** `{{1}}` → `contact.firstName` · `{{2}}` →
`organization.name` · `{{3}}` → `appointment.date` · `{{4}}` → `appointment.time`.

**Creación turnkey:** `node packages/database/scripts/create-agendamiento-templates.mjs`
(ver cabecera del script: necesita `API_URL`, `TOKEN` admin y `CHANNEL_ID`). Crea las
4 en Meta con cuerpo + ejemplos + botones + binding, y quedan `PENDING` hasta que Meta
las apruebe. Alternativa: crearlas a mano en Canales → Plantillas con estos datos.

Los taps de los botones ya los maneja TuBot (`apps/worker/src/appointment-responses.ts`):
**Confirmar** → confirma la cita (write-back a Cláriva) + acuse y corta el 2.º recordatorio;
**Reagendar/Quiero retomarlo** → libera el cupo y el agente `agendamiento` ofrece horarios.

---

## 1) `recordatorio_cita` — UTILITY — vars 1-4

> Hola {{1}} 👋 Te recordamos tu cita en {{2}} el {{3}} a las {{4}}. ¿Confirmas tu asistencia?

- **Variables:** `["contact.firstName","organization.name","appointment.date","appointment.time"]`
- **Botones (quick reply):** `Confirmar` · `Reagendar`
- **Ejemplos:** `["María","Digital Dent","lunes 6 de octubre","15:30"]`

## 2) `recordatorio_cita_insistencia` — UTILITY — vars 1-4

> Hola {{1}} 👋 Solo para confirmar tu cita de mañana en {{2}} el {{3}} a las {{4}}. ¿Nos confirmas que vienes?

- **Variables:** `["contact.firstName","organization.name","appointment.date","appointment.time"]`
- **Botones (quick reply):** `Confirmar` · `Reagendar`
- **Ejemplos:** `["María","Digital Dent","lunes 6 de octubre","15:30"]`

## 3) `recaptura_noshow` — MARKETING — vars 1-2

> Hola {{1}} 👋 Vimos que no pudiste asistir a tu cita en {{2}}. ¿Quieres que te ayudemos a reagendar? Estamos para apoyarte 😊

- **Variables:** `["contact.firstName","organization.name"]`
- **Botones (quick reply):** `Reagendar`
- **Ejemplos:** `["María","Digital Dent"]`

## 4) `recaptura_tratamiento` — MARKETING — vars 1-2

> Hola {{1}} 👋 Notamos que tu tratamiento en {{2}} quedó pendiente. Retomarlo a tiempo hace la diferencia en tu salud. ¿Lo retomamos?

- **Variables:** `["contact.firstName","organization.name"]`
- **Botones (quick reply):** `Quiero retomarlo`
- **Ejemplos:** `["María","Digital Dent"]`
