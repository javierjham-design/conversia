# Flujo de recordatorio de cita (borrador de referencia)

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
