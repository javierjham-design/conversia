# Agendamiento

## Contrato estándar

`SchedulingProvider` (`@conversia/types`) — 15 métodos: getClinics, getProfessionals, getServices, getProfessionalServices, getAvailableSlots, createAppointment, updateAppointment, cancelAppointment, confirmAppointment, getAppointment, getPatientAppointments, createOrUpdatePatient, markAttendance, markNoShow.

Implementaciones (`packages/scheduling`):
- **MockSchedulingProvider**: en memoria, slots deterministas L-S 10:00–18:00 cada 30 min, valida doble reserva, se alimenta con los datos reales del tenant (sedes/profesionales/servicios de la BD). Singleton por organización durante la vida del proceso.
- **ClarivaSchedulingProvider**: HTTP contra el contrato preliminar (CLARIVA.md), timeout 10 s.
- Futuras: Dentalink, Google Calendar, genérico (misma interfaz).

## Selección por tenant

`scheduling_connections` (provider + config + credencial cifrada, por organización o sede). Sin conexión → `SCHEDULING_PROVIDER` del entorno (mock en dev). Una organización puede usar proveedores distintos por sede (la resolución acepta clinicId — v0 usa la primera conexión activa; refinamiento pendiente).

## Reglas anti-invención (aplicadas)

1. La tool `getAvailability` es la única fuente de horarios que ve el modelo (máx. 6 slots).
2. `createAppointment` exige un `startIso` exacto de un slot devuelto; el proveedor re-valida (mock/Cláriva devuelven conflicto → el modelo recibe el error y ofrece otra hora).
3. Tras reservar: `appointments` local (proyección con `external_id`), auditoría, y evento para workflows (confirmaciones/recordatorios).
4. Datos mínimos del paciente: nombre + teléfono (ya presentes por WhatsApp); el prompt exige confirmar servicio/fecha/hora/sede antes de reservar.

## Google Calendar en dos sentidos (agenda NATIVA)

Para las cuentas con agenda nativa, Google Calendar funciona en los dos sentidos. Las que
tienen agenda externa (Cláriva/Dentalink) conservan su proveedor como fuente de verdad y
Google queda solo como espejo.

| Pieza | Dónde |
| --- | --- |
| Forma de la config (`calendarId`, `calendarSync`, `calendarReadBusy`, `calendars[proId]`) | `packages/config/src/google-calendars.ts` |
| Espejo Conversia → Google (y a qué calendario va cada cita) | `apps/worker/src/google-calendar.ts` |
| Horas ocupadas Google → disponibilidad | `packages/scheduling/src/google-busy.ts` (gancho `externalBusy` del proveedor nativo) |
| Cambios Google → Conversia (sondeo + `syncToken`) | `apps/worker/src/google-sync-back.ts` |
| Pantallas | `apps/conversia-web`: botón en `/agenda`, configuración en `/agenda/configurar` |

Reglas que conviene no olvidar:

- Los eventos que creamos llevan `extendedProperties.private.conversiaAppointmentId`. Eso es
  lo que evita que una cita **se bloquee a sí misma** al reagendar y lo que distingue lo
  nuestro de los eventos personales del dueño.
- `appointment.meta` guarda `googleEventId` (qué evento), `googleCalendarId` (en qué
  calendario) y `googleUpdated` (anti-bucle del sondeo).
- Si Google falla, la disponibilidad se calcula solo con la agenda nativa. El bot nunca se
  queda mudo por un problema de Google.
- **Borrar el evento en Google no cancela la cita** (ADR-13): la marca para revisar.

## Pendiente

Trigger `appointment_upcoming` (crear scheduled_job al crear cita) · reagendamiento conversacional completo (updateAppointment tool) · webhooks entrantes de proveedores → estados de cita.

## Zona horaria

La hora local sale de `organizations.timezone` (zona IANA, `America/Santiago` por defecto) y el
offset se calcula **por día** en `packages/scheduling/src/zona.ts`. No hay offsets escritos a
mano en ninguna parte del camino de la agenda, y un test los busca
(`apps/api/test/agenda-hora-chile.spec.ts`).

Por qué importa: Chile está en `-04:00` en invierno y en `-03:00` de septiembre a abril. Con el
offset fijo que había antes, un negocio abierto de 09:00 a 19:00 recibía ofertas de 10:00 a
20:00 durante medio año —y en invierno el error desaparecía solo, que es la razón de que
viviera meses sin que nadie lo notara—. Un rango de varios días puede cruzar el cambio de hora,
así que el offset **nunca** se resuelve una vez por consulta: se resuelve por cada fecha.

Una sede en otro país funciona igual: lo que manda es la zona, no un ajuste. Lo que no cambia
son las citas ya guardadas: en la base viven como instantes absolutos.
