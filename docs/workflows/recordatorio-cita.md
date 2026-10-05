# Flujo de recordatorio de cita (borrador de referencia)

> **Actualización (2026-10-04) — Cierre de agendamiento.** El recordatorio ya NO
> es de 1 envío: pasa a **dos envíos el día ANTERIOR** (12:00 + 18:00 si no
> responde) y lo siembra `packages/database/scripts/seed-agendamiento-workflows.sql`
> (workflow **"Recordatorio de cita"**). La definición canónica vive en ese seed;
> este doc queda como referencia del diseño. Cadencia real:
>
> 1. **R1 a las 12:00** del día anterior (hora fija vía `trigger.config.sendAt =
>    { daysBefore: 1, time: "12:00" }`; ver `planAppointmentReminder`/`sendAtDue`).
>    Plantilla `recordatorio_cita`.
> 2. `wait_reply` 6 h. Si el paciente **responde** → `switch_agent` a
>    **agendamiento** (confirma con `confirmAppointment` o reagenda) y **R2 no se
>    envía**.
> 3. Si **no responde** en 6 h → **R2 insistencia (~18:00)**, plantilla
>    `recordatorio_cita_insistencia`.
> 4. `wait_reply` 18 h. Si responde → `switch_agent` a agendamiento.
>
> Regla de negocio: **R2 jamás se envía si ya respondió a R1** (cualquier respuesta
> entra por la rama `replied`). El botón "Confirmar" lo resuelve ahora el agente con
> la tool **`confirmAppointment`** (deja la cita *Confirmada* en Cláriva), ya no el
> flujo por palabra clave de la §3. Son **4 plantillas** en total (ver §2 y §2-bis).
>
> **Actualización (2026-10-05) — §1.4: horarios y toggle de R2 DESDE el payload.** El
> Gestor de IA de Cláriva configura los horarios y el on/off de la 2ª reconfirmación
> por clínica; Cláriva los manda en el payload de `appointment.created/rescheduled`:
> ```json
> "reminders": { "enabled": true, "first": {"time":"12:00"}, "second": {"enabled":true,"time":"18:00"} }
> ```
> Mapeo en TuBot (manda sobre las horas fijas del workflow; **backward-compat** si el
> payload no trae `reminders`):
> - **R1** → `dueAt` el día anterior a `reminders.first.time` (si falta, al `sendAt`
>   fijo del workflow, 12:00).
> - **wait_reply n2** → timeout = `second.time − first.time` vía variable del run
>   `__r2DelayHours` (nodo con `config.hoursVar`); si falta, su `hours` estático.
> - **2ª reconfirmación** → nodo condición `n2b` (`kind:"flag"`, `var:"__r2Enabled"`,
>   `default:true`): si `reminders.second.enabled === false` termina sin R2.
> El toggle `reminders.enabled === false` equivale a `remindersEnabled:false` (§1.3):
> no se programa ningún recordatorio.


Hallazgo (2026-08-04): el flujo publicado **"Confirmación de cita"** de Digital
Dent usa `send_text` como primer paso. Eso está **roto** para el caso real:

1. Un recordatorio 24 h antes se envía con la ventana de servicio de 24 h
   **cerrada** (la cita se agendó hace días) → WhatsApp **no entrega** texto
   libre; solo entrega **plantillas HSM** aprobadas.
2. El run del recordatorio arranca con `variables: {}` (no pasa por
   `buildRunVars`), así que `{{contact.firstName}}` / `{{appointment.date}}` en
   un `send_text` salen **vacíos**. Solo `send_template` rellena las variables
   (vía `resolveTemplateParams`, que las lee de la BD por clave semántica).

**Conclusión:** el recordatorio DEBE usar `send_template`. Abajo el flujo
corregido y la plantilla a crear en Meta.

## 1) Definición del flujo corregido (borrador — publícalo tú)

```json
{
  "trigger": { "type": "appointment_upcoming", "config": { "hoursBefore": 24, "avoidOffHours": true } },
  "variables": {},
  "nodes": [
    {
      "id": "recordatorio",
      "type": "send_template",
      "name": "Recordatorio por WhatsApp",
      "config": { "templateId": "<ID_DE_recordatorio_cita>", "templateName": "recordatorio_cita" },
      "position": { "x": 240, "y": 160 }
    }
  ],
  "edges": []
}
```

`templateId` es el id de fila en `whatsapp_templates` tras sincronizar la
plantilla; en el canvas se elige del desplegable del nodo (lo rellena solo).
Como es un flujo de 1 nodo, lo más rápido es armarlo en el canvas: nuevo flujo →
disparador **"Recordatorio de cita"** (24 h) → paso **"Enviar plantilla
WhatsApp"** → elegir `recordatorio_cita`. No publicar hasta revisar.

## 2) Plantilla HSM a crear en Meta

- **Nombre:** `recordatorio_cita`
- **Categoría:** **UTILITY** (no MARKETING — Meta la clasifica/cobra distinto)
- **Idioma:** Español (`es`)
- **Cuerpo (4 variables, en este orden):**

  > Hola {{1}} 👋 Te recordamos tu cita en {{2}} el {{3}} a las {{4}}. ¿Confirmas tu asistencia?

- **Botones (quick reply):** `Confirmar` · `Reagendar`

### Mapeo posición → dato (se fija al sincronizar, en `whatsapp_templates.body.variableFields`)

| # | Variable | Campo (`variableFields`) |
|---|----------|--------------------------|
| 1 | nombre paciente | `contact.firstName` |
| 2 | clínica | `organization.name` |
| 3 | fecha | `appointment.date` |
| 4 | hora | `appointment.time` |

```
variableFields = ["contact.firstName","organization.name","appointment.date","appointment.time"]
```

> **Decisión (2026-08-04): 4 variables por ahora.** Se dejó "servicio" fuera
> porque si esa variable llega vacía, WhatsApp rechaza el envío completo y el
> recordatorio no sale. Las 4 (nombre, clínica, fecha, hora) sí se rellenan de la
> BD (`resolveTemplateParams`).
>
> **v2 con servicio (cableado, pendiente de verificación):** el webhook de Cláriva
> ahora guarda `meta.serviceName` (si el payload lo trae) y `resolveTemplateParams`
> expone `appointment.serviceName` (y `appointment.service` cae a él). Falta
> **verificar con una cita real** que Cláriva envía el nombre del servicio en el
> webhook; si solo manda `serviceId`, hará falta un pull de `services`. Cuando esté
> verificado se crea la plantilla v2 con la 5.ª variable `appointment.serviceName`.

## 2-bis) Plantilla de insistencia (R2, ~18:00) — `recordatorio_cita_insistencia`

Segunda plantilla del nuevo recordatorio de 2 envíos. Se envía solo si el paciente
NO respondió a `recordatorio_cita` dentro de las 6 h (≈ 18:00 del día anterior).

- **Nombre:** `recordatorio_cita_insistencia`
- **Categoría:** **UTILITY**
- **Idioma:** Español (`es`)
- **Cuerpo (4 variables, MISMO orden y mapeo que `recordatorio_cita`):**

  > Hola {{1}} 👋 Solo para confirmar tu cita de mañana en {{2}} el {{3}} a las {{4}}. ¿Nos confirmas que vienes?

- **Botones (quick reply):** `Confirmar` · `Reagendar`

```
variableFields = ["contact.firstName","organization.name","appointment.date","appointment.time"]
```

> Debe quedar **APPROVED** igual que `recordatorio_cita`; el seed de workflows omite
> el flujo "Recordatorio de cita" mientras falte CUALQUIERA de las dos.

## 3) Respuestas a los botones (interino, sin código)

El inbound ya convierte el tap del botón en texto (`button.text`), así que estos
dos flujos por palabra clave funcionan hoy:

- **Confirmar** → `message_received` keyword "Confirmar" → `send_text` "¡Gracias!
  Tu cita queda confirmada ✅" + `add_tag` "cita-confirmada".
- **Reagendar** → `message_received` keyword "Reagendar" → `send_text` "Con gusto
  te ayudo a reagendar 📅" + `transfer_human` (recepción).

Lo que falta (bloque **AGENDA-2**, requiere código): confirmar la cita de verdad
(estado + write-back a Cláriva) y disparar `appointment_confirmed` desde el
botón. Encolar cuando se decida.
