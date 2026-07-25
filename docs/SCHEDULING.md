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

## Pendiente

Trigger `appointment_upcoming` (crear scheduled_job al crear cita) · reagendamiento conversacional completo (updateAppointment tool) · zonas horarias por sede en slots del mock (hoy offset fijo -04:00) · webhooks entrantes de proveedores → estados de cita.
