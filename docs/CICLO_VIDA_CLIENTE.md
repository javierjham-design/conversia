# CICLO_VIDA_CLIENTE.md — Altas, bajas y migraciones (Conversia / TuBot)

Procedimientos operativos del ciclo de vida de un cliente. Cierra las brechas que el
auditor pre-producción exige tener **al menos documentadas** antes del lanzamiento
(ver `docs/PROMPTS_CONVERSIA.md` §"Qué queda fuera" y `RISK_REGISTER.md`). Donde todavía
no hay feature, el camino **manual del operador** es el procedimiento vigente.

> Marca: todo lo de abajo aplica por-marca. El super admin/operador solo ve y opera los
> tenants de SU marca (D8). Nada de esto degrada a TuBot (regla de oro).

---

## 1. Alta (resumen — ya implementado en F10)

El cliente se registra en `app.conversia.cl` (crea org + owner, prueba de 7 días). El
EQUIPO lo pone en marcha desde la **consola → Alta guiada**: instalar paquete del rubro →
conectar WhatsApp → publicar agente/flujo → checklist → **Marcar ENTREGADO** (GO-LIVE).
Marcar ENTREGADO exige **setup pagado** y activa el ciclo de cobro (D5). Auditado
(`platform.org.delivered`).

---

## 2. Offboarding / baja de un cliente Conversia

Cuando un cliente se da de baja (voluntaria o por impago terminal):

1. **Suspender el servicio.** Consola → ficha del cliente → estado `SUSPENDED` (o
   `CANCELLED`). Esto corta el envío (gate) pero conserva los datos. Auditado.
2. **Número de WhatsApp (WABA).** El número es del cliente; la WABA la administramos
   nosotros (D3). Procedimiento de **handover**:
   - Si el cliente se va a otro proveedor: iniciar la **portabilidad/migración del número**
     desde Meta Business Manager (el cliente debe aceptar en su BM). Documentar fecha y
     confirmación. Hasta que el número salga, mantener la WABA activa pero sin cobro de
     servicio nuevo.
   - Si el cliente deja de usar WhatsApp: dar de baja el `phone_number_id` en Meta tras el
     plazo de retención (abajo).
3. **Export de datos.** Entregar al cliente sus datos con el exportador existente
   (`exports.ts` → conversaciones, contactos, agenda, caja). Dejar constancia del envío.
4. **Retención y purga.** Retención por defecto **90 días** tras la baja (permite
   reactivación y disputas). Pasado el plazo: purga de datos del tenant (hoy manual vía
   script acotado por `organizationId`; existe purga automática solo para trials). La IA de
   caja es **append-only**: los asientos no se borran (se conservan para cuadratura), salvo
   purga total del tenant al final de la retención.
5. **Facturación.** Cerrar suscripción y pendientes. Ver permanencia (§3).

**Mínimo para lanzar:** este procedimiento escrito + confirmar quién ejecuta cada paso.
**Feature futura:** botón "Dar de baja" en la ficha que orqueste suspensión + export +
agendar purga.

---

## 3. Permanencia (6 meses)

El contrato de Conversia considera una **permanencia de 6 meses** (recupera el costo de
implementación y el subsidio de los primeros meses).

- **Hoy el enforcement es MANUAL.** No se cobra automáticamente la salida anticipada.
- **Mínimo para lanzar:** la cláusula debe estar **en el contrato/condiciones** que el
  cliente acepta, y el proceso de cobro de la salida anticipada (si se decide aplicarlo) lo
  ejecuta el equipo comercial caso a caso.
- Registrar el inicio de la permanencia en `settings.contract` del tenant (campo informativo,
  p. ej. `{ commitmentMonths: 6, startedAt }`) al marcar ENTREGADO, para tenerlo a la vista.
- **Feature futura:** mostrar meses restantes de permanencia en la ficha y bloquear la
  cancelación self-service antes del término (o cobrar el saldo).

---

## 4. Migración de marca (TuBot ↔ Conversia)

Decisión: ambas direcciones son posibles. **Hoy es un runbook MANUAL del operador** (no hay
flujo automatizado). Como la identidad está separada por marca (D8: `@@unique([email, brand])`),
un mismo correo es una cuenta distinta en cada marca.

Procedimiento manual (super admin):
1. Confirmar el destino (marca + plan equivalente) y respaldar (pg_dump).
2. Cambiar `organization.brand` al destino + asignar el plan de esa marca + ajustar
   `settings` (acento por país, lifecycle, features del plan).
3. La cuenta del usuario: crear/invitar la cuenta en la marca destino (es independiente).
   El panel que ve el cliente se resuelve por el Origin del dominio de esa marca.
4. Revisar canales/WABA y catálogo (los paquetes verticales son por-tenant).
5. Auditar el cambio y avisar al cliente del nuevo dominio de acceso.

**Riesgo:** cambiar `brand` reencuadra el aislamiento del super admin; hacerlo con respaldo y
verificación post-cambio (el cliente ve su panel, envía, cobra). **Feature futura:** asistente
de migración que haga los pasos 2–4 transaccionalmente.

---

## 5. Boleta / factura tributaria (DTE)

**Fuera de alcance de la plataforma por decisión previa** (ver `project_clariva_billing` /
`CONVERSIA_COSTOS.md`). Conversia cobra (Flow CLP / Lemon Squeezy USD) pero **la emisión del
DTE/boleta se hace fuera** de la plataforma. El auditor pre-producción debe **confirmar con el
dueño que la decisión se mantiene** al lanzar. Si en el futuro se exige DTE in-app, es un
proyecto aparte (integración con el emisor tributario).
