# CICLO_VIDA_CLIENTE.md — Altas, bajas y migraciones (Conversia / TuBot)

Procedimientos operativos del ciclo de vida de un cliente. Cierra las brechas que el
auditor pre-producción exige tener **al menos documentadas** antes del lanzamiento
(ver `docs/PROMPTS_CONVERSIA.md` §"Qué queda fuera" y `RISK_REGISTER.md`). Donde todavía
no hay feature, el camino **manual del operador** es el procedimiento vigente.

> Marca: todo lo de abajo aplica por-marca. El super admin/operador solo ve y opera los
> tenants de SU marca (D8). Nada de esto degrada a TuBot (regla de oro).

---

## 1. Alta (resumen — F10 + B6)

**Conversia NO usa el trial autoservicio 7+7 de TuBot** (B6/F5). Al registrarse en
`app.conversia.cl` la org **nace "pendiente de implementación"** (`settings.conversia.lifecycle =
"pending"`): existe y es operable por el EQUIPO, pero **sin countdown, sin purga y sin
suscripción contadora** (el worker de trial ya exime a la marca conversia). TuBot conserva su
prueba de 7 días intacta.

El EQUIPO lo pone en marcha desde la **consola → Alta guiada**: instalar paquete del rubro →
conectar WhatsApp → publicar agente/flujo → checklist → **Marcar ENTREGADO** (GO-LIVE).

- **Marcar ENTREGADO** exige **setup pagado** y **arranca el ciclo de cobro** (crea/activa la
  suscripción ACTIVE desde la fecha de entrega) + fija la permanencia (contrato 6 meses, F-1).
  Auditado (`platform.org.delivered`). `lifecycle → "active"`.
- **Override de entrega** (B6): un **super admin** puede entregar **sin setup pagado** pasando
  `{ override: true, reason }` (motivo obligatorio). Queda auditado con `override` + motivo y marca
  `conversia.deliveredOverride`. Botón "Entregar con override…" en la ficha.
- **Cuenta demo** (B6): un super admin puede marcar una org como **demo interna** (`lifecycle =
  "demo"`): operativa, **sin cobro ni purga**. Endpoint `POST .../lifecycle/demo`, auditado
  (`platform.org.demo`). Botón "Marcar como demo" en la ficha.

### Verificación de correo (B7 / D6)

Política antiabuso por marca:

- **Registro público (Conversia)**: la cuenta nace con el correo **sin verificar** y se le envía
  el enlace de verificación. La verificación es **blanda** (no bloquea el login) + **aviso
  persistente** en el panel con botón "Reenviar". El antiabuso duro es **estructural**: una cuenta
  self-service **no puede ir en vivo ni enviar** hasta que el EQUIPO la marque ENTREGADA (setup
  pagado, B6) — un registro falso no causa daño.
- **Gate concreto**: un dueño con el correo **sin verificar no puede invitar más usuarios**
  (evita que cuentas no verificadas generen más cuentas). Exento: cuentas **demo** y usuarios ya
  verificados.
- **Invitados por el equipo/dueño**: su correo queda **verificado al aceptar** la invitación
  (recibieron el enlace en su bandeja → de confianza; sin fricción de verificación).
- **TuBot**: sin cambios (no exige verificación).

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
4. **Retención y purga.** Al poner la org en `CANCELLED` (consola → ficha → estado), el
   sistema marca automáticamente `settings.offboarding = { cancelledAt, purgeAt: +90 días,
   retentionDays: 90 }` (F-3). Esa fecha `purgeAt` es la SEÑAL y el disparador: permite
   reactivación/disputas dentro de la ventana (al REACTIVAR se limpia la marca). **La purga
   en sí es un paso MANUAL del operador** (no se auto-borra en un timer, por ser destructiva):
   pasado `purgeAt`, correr el script de purga acotado por `organizationId` contra la BD de
   prod (`railway run -s Postgres`, ver [[reference_conversia_prod_deploy_tooling]]) con
   backup previo. La IA de caja es **append-only**: los asientos no se borran (se conservan
   para cuadratura) salvo purga total del tenant al final de la retención. Antes de purgar,
   entregar el export (incluye ahora la **caja**, F-2).
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
