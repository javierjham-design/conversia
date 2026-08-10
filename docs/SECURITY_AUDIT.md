# Auditoría de seguridad — Conversia / TuBot

Fecha: 2026-08-10 · Alcance: producción (api + worker + web, Postgres/RLS, BullMQ,
Railway) · Método: revisión de código con criterio de atacante + verificación de
rutas de envío, límites, autenticación y webhooks. Complementa
[`SECURITY_THREAT_MODEL.md`](./SECURITY_THREAT_MODEL.md).

> **Sé brutalmente honesto** era el encargo. Lo soy: el aislamiento entre tenants,
> la autenticación y los webhooks están **bien**. El eje **financiero** está
> **abierto** — no por un descuido puntual sino porque la protección estructural
> (bolsa prepagada + fusible) todavía no existe. Nada de esto es sorpresa: es
> justo lo que el encargo pide blindar. **No corregí nada** (salvo avisar, abajo).

## ⚠️ Aviso de exposición activa (leer primero)
Hoy, en producción, **cualquier tenant activo (o en gracia, o en demo) puede
enviar plantillas de WhatsApp sin ningún tope aplicado en el punto de envío**, y
el costo lo financia nuestra línea de crédito hasta la factura de Meta. No es un
exploit exótico: es armar un flujo o una campaña. **No lo corrijo sin tu OK**
(implica construir la bolsa del Eje 1.2), pero si quieres una **contención
inmediata y barata** mientras se construye, ver "Mitigación puente" al final.

---

## 1. Lo que YA está bien resuelto (no gastar esfuerzo aquí)

| Área | Estado | Evidencia |
|---|---|---|
| **Aislamiento multi-tenant (RLS)** | ✅ Sólido | RLS en toda tabla con `organization_id` (política `tenant_isolation`), rol `conversia_app` **sin BYPASSRLS**, `organization_id` siempre del servidor/JWT, job CI `tenant-isolation` en cada push. |
| **No se acepta `organizationId` del cliente** | ✅ | Búsqueda sin resultados de `body.organizationId` en rutas de tenant. |
| **JWT endurecido** | ✅ | HS256 fijado (anti alg-confusion), issuer+audience validados, expiración 12 h, `jti` único. |
| **MFA** | ✅ | Tenant (TOTP + recovery de un solo uso) y **Super Admin obligatorio** (`SUPER_ADMIN_REQUIRE_MFA` default on; el guard bloquea `/platform/*` salvo `/platform/auth/*` hasta activarlo). |
| **Webhooks de pago** | ✅ | Firma verificada (Stripe/Lemon Squeezy HMAC del raw; Flow vía `getStatus` firmado) + **idempotencia** (`webhook_events` por `provider+eventId`, insert atómico). |
| **Cabeceras / CSP / CORS** | ✅ | helmet (CSP, HSTS preload), `X-Frame-Options: DENY`, CORS acotado a `WEB_URL` con credenciales; CSP de prod prohíbe `unsafe-eval`. |
| **SSRF** | ✅ | Guard en el paso HTTP de flujos (bloquea IPs internas; `url-guard.spec.ts`). |
| **Inyección de prompt (variables)** | ✅ (parcial) | `sanitizeVar` aplicado a toda `{{var}}` interpolada en el prompt; el mensaje del contacto va como rol *user*, no *system*. |
| **Secretos** | ✅ | `secret-scan`/gitleaks en CI (verde), credenciales de integración **cifradas en reposo**, la API no devuelve secretos completos, `appsecret_proof` en llamadas a Graph. |
| **Backups** | ✅ | Copia off-Railway cada 6 h con **restore verificado** + runbook DR probado. |
| **Suspensión = solo lectura** | ✅ | `BillingSuspensionGuard` bloquea mutaciones (402) de orgs SUSPENDED/CANCELLED, con allowlist para pagar. |
| **audit_logs no se borran desde la app** | ✅ (con matiz, ver M3) | Sin `auditLog.delete/update` en el código. |

---

## 2. Hallazgos

Cada uno: **cómo se explota · impacto (en $ si es financiero) · cómo se corrige**.
Referencias de costo (rate card Meta CL, cargado en la plataforma): **utilidad
≈ $17,66 CLP**, **marketing ≈ $78,49 CLP** por mensaje. Límites de mensajería de
Meta por número (conversaciones iniciadas por negocio / 24 h): **250 → 1.000 →
10.000 → 100.000 → ilimitado**, según calidad/antigüedad.

### 🔴 CRÍTICO

#### C1 — No existe tope de gasto de mensajería en el punto de envío
- **Cómo se explota**: un tenant arma un flujo o una campaña que dispara
  plantillas a toda su base. Ninguna de las rutas de envío (bandeja, flujos,
  agentes, **recordatorios del worker**, reintentos de cola) consulta saldo o
  cupo **antes** de enviar. El consumo se registra **después** (webhook de estado
  de Meta): cuando lo contamos, el dinero ya salió.
- **Impacto ($)**: **no acotado por lo que pagó el cliente**. Techo práctico = el
  tier de Meta del número. Ejemplos por número/día: tier 1.000 ≈ **$17.660 CLP**
  (utilidad) a **$78.490 CLP** (marketing); tier 100.000 ≈ **$1.766.000** a
  **$7.849.000 CLP/día**. Multiplicado por tenants/números. Un solo flujo mal
  armado en un cliente puede costar cientos de miles de pesos en horas.
- **Cómo se corrige**: **bolsa de mensajes prepagada** (Eje 1.2) con **débito
  atómico ANTES del envío** en un punto único por el que pasen TODAS las rutas
  (encolar el outbound descuenta saldo en la misma transacción; sin saldo, no se
  encola). Más **tope duro por tenant** y **fusible global** (Eje 1.4). Detalle de
  diseño abajo (§3).

#### C2 — La demo puede quemar mensajes y el registro no tiene antiabuso
- **Cómo se explota**: registro abierto (solo rate-limit por IP, **sin
  verificación de correo ni teléfono**). La org queda en TRIAL y **el envío no
  distingue TRIAL de pagado** → envía plantillas igual. **Sin dedup** de
  registros (dominio de correo, teléfono, RUT, IP, huella), se repite con otra
  identidad. La demo **no expira** por sí sola en el envío.
- **Impacto ($)**: por identidad nueva, el techo inicial de Meta (~250 conv./24 h)
  ≈ **$4.415 CLP/día** (utilidad) a **$19.622 CLP/día** (marketing), **repetible**
  cuantas identidades logre crear. Sangría continua y difícil de atribuir.
- **Cómo se corrige** (Eje 1.3): en demo, **cero** envío de plantillas o cupo
  **simbólico 5–10** (recomendado: **5**, alcanza para probar un recordatorio) —
  el resto de la plataforma funciona (agentes, flujos, simulador, y responder
  dentro de la ventana de 24 h, que no cuesta). **Expiración automática** visible.
  Antiabuso mínimo razonable: **verificar correo + teléfono (OTP)**, **una demo
  por RUT de empresa y por número de WhatsApp**, **dedup** por dominio/IP/huella
  con revisión, y **bloqueo manual** desde el Super Admin. (Mínimo para no
  espantar clientes: correo + teléfono verificados + una demo por número.)

### 🟠 ALTO

#### H1 — Durante la gracia se siguen enviando plantillas (financiamos al moroso)
- **Cómo se explota**: al vencer el período, el dunning marca la suscripción
  `PAST_DUE` pero deja la **org en `ACTIVE`** y "sigue operando" 7 días. En un
  modelo **prepago**, eso significa **7 días de mensajería financiada por
  nosotros** a quien ya dejó de pagar.
- **Impacto ($)**: hasta 7 días del volumen del tenant × tarifa, por cada moroso.
- **Cómo se corrige** (Eje 1.5): la gracia mantiene **acceso al panel** pero
  **no** el envío de plantillas. Condicionar el envío a **suscripción `ACTIVE`**
  (no `PAST_DUE`) y/o a **saldo de bolsa vigente**. Los mensajes de servicio
  (dentro de 24 h, gratis) pueden seguir.

#### H2 — Sin protocolo de desvinculación: WABA huérfana sobre nuestro crédito
- **Cómo se explota**: un tenant se va/suspende/elimina y **nadie revoca** la
  compartición de línea de crédito ni los permisos sobre su WABA del lado de Meta.
  No hay **chequeo periódico** que lo detecte. Sigue facturándonos en silencio.
  (Eliminar el canal en el panel borra número/WABA **locales**, pero no toca la
  relación de crédito en Meta.)
- **Impacto ($)**: meses de facturación de Meta sin ingreso asociado. El "agujero
  silencioso" que más cuesta porque no da la cara.
- **Cómo se corrige** (Eje 1.6): **checklist ejecutable** desde el Super Admin
  (revocar crédito compartido → permisos WABA → tokens → accesos → plantillas, en
  ese orden) + **job periódico** que alerte "WABA X sigue asociada a nuestro
  crédito y su tenant está suspendido/eliminado". Marcar para abogado (§4).

#### H3 — Sin fusible global, sin detección de anomalías, sin reconciliación
- **Cómo se explota**: no hace falta malicia — un **bug nuestro** en un loop o un
  **flujo mal armado** por un cliente basta. Nada corta el gasto agregado.
- **Impacto ($)**: el peor caso del C1 pero sin límite por-tenant que lo acote;
  puede escalar en minutos.
- **Cómo se corrige** (Eje 1.4): **fusible global** = techo de gasto agregado
  diario que, al superarse, **corta los envíos de plantilla de todos** y alerta.
  **Detección de anomalías**: tenant que multiplica su volumen histórico → alerta
  y, si es extremo, freno automático pendiente de revisión. **Reconciliación**:
  comparar lo que creemos enviado (usage_events) contra lo que Meta reporta haber
  cobrado y avisar diferencias (delata envíos no contabilizados).

### 🟡 MEDIO

#### M1 — El consumo se contabiliza post-envío, no con débito atómico previo
- Hoy `usage_events` (whatsapp_message / tokens IA) se escriben **después** del
  envío/llamada. Aunque exista la bolsa, si el débito no es **atómico y previo**
  hay condiciones de carrera (enviar dos veces con el último crédito; reintentos
  de cola que reprocesan sin descontar). **Corrección**: el débito debe ocurrir en
  la **misma transacción** que crea el mensaje saliente, con `SELECT ... FOR
  UPDATE` o `UPDATE ... WHERE saldo >= costo RETURNING` (rechaza si no alcanza), y
  jobs **idempotentes por `messageId`** para que un reintento no descuente doble.

#### M2 — Sesiones de tenant no revocables
- El `jti` existe pero **no hay denylist**. Cambiar la contraseña o **bajar el rol**
  no invalida las sesiones activas: el token vale hasta **12 h** y los permisos van
  **dentro del JWT**. Un ex-empleado de un tenant o un token filtrado sigue
  operando hasta la expiración. **Corrección**: denylist de `jti` en Redis (como ya
  hace el Super Admin) o `tokenVersion` por usuario que invalide al cambiar
  clave/rol. Bajar `JWT_EXPIRES_IN` es un parche parcial.

#### M3 — Inmutabilidad de `audit_logs` depende de "no hay código", no del motor
- `setup.sql` concede `INSERT,SELECT,UPDATE,DELETE` sobre **todas** las tablas a
  `conversia_app`, incluida `audit_logs`. Hoy ningún endpoint borra/edita, pero no
  hay barrera de BD; y el Super Admin (rol owner) puede todo. **Corrección**:
  `REVOKE UPDATE, DELETE ON audit_logs FROM conversia_app;` (y del rol de app), y
  evaluar un trigger `BEFORE UPDATE OR DELETE` que aborte. Para el owner, dejar
  registro fuera de banda (los logs de plataforma ya viven aparte).

#### M4 — Super Admin sin allowlist de IP por defecto
- MFA obligatorio ✅, pero `SUPER_ADMIN_ALLOWED_IPS` viene **vacío** (sin
  restricción). Es la llave del negocio. **Corrección**: cargar la IP fija/VPN de
  administración en `SUPER_ADMIN_ALLOWED_IPS` (el guard ya lo soporta).

#### M5 — El webhook de pago no cruza monto pagado vs precio del plan
- Firma + idempotencia ✅, y el `planCode` viene de metadata creada por el
  servidor. Pero no se verifica que el **monto pagado == precio del plan**. Como
  defensa en profundidad (por si el checkout permitiera desacoplar monto y plan),
  **agregar** esa comprobación antes de activar.

### 🔵 BAJO

- **L1 — Rate-limit fino**: la API autenticada se limita por usuario y login/
  registro por email/IP, pero conviene un límite **más estricto en endpoints
  costosos** (IA, exports) y confirmar cobertura en la **API pública** y webhooks.
- **L2 — Verificación de correo** pendiente (roadmap): se subsume en C2.
- **L3 — Revisar CSP**: confirmar que no haya `unsafe-inline` innecesario en
  `script-src` (el `unsafe-eval` ya está prohibido).

---

## 3. Diseño propuesto — Bolsa de mensajes prepagada (el corazón del blindaje)

> Propuesta de modelo; **no implementada**. Requiere migración → tu OK primero.

### Modelo de datos
- `message_wallet` (uno por org): `organizationId (unique)`, `balance` (int,
  mensajes de plantilla), `includedPerPeriod`, `carryoverCap` (tope de acumulación
  = **1 mes de bolsa**, por tu decisión), `periodStart`, `updatedAt`.
- `wallet_ledger` (movimientos, append-only): `organizationId`, `delta` (+/−),
  `reason` (`plan_renewal | package_purchase | send_debit | refund | adjust`),
  `balanceAfter`, `refType` (messageId / invoiceId), `createdAt`. Es la fuente de
  verdad auditable.
- `message_package` (catálogo de paquetes adicionales): `code`, `messages`,
  `priceClp/priceUsd`, `active`.

### Débito atómico y previo (sin condiciones de carrera)
En la MISMA transacción que crea el `message` saliente de tipo TEMPLATE:
```sql
UPDATE message_wallet SET balance = balance - :cost
 WHERE organization_id = :org AND balance >= :cost
 RETURNING balance;   -- 0 filas = sin saldo → NO se crea el mensaje ni se encola
```
Registrar el `wallet_ledger` con `refType=messageId`. El job de outbound es
**idempotente por messageId**: si reintenta, no vuelve a descontar (el descuento
ya quedó ligado al mensaje). **Servicio (24 h) = gratis**, no toca la bolsa.

### Renovación y acumulación
Al renovar (webhook de pago): `balance = min(balance, carryoverCap) +
includedPerPeriod`, con `carryoverCap = includedPerPeriod` (1 mes). Así nadie
junta seis meses para un envío masivo que descalabre el gasto de golpe.

### Compras de paquete
Reutilizar el checkout existente (Flow CLP / Lemon Squeezy USD): el webhook, ya
firmado e idempotente, acredita `+messages` al `wallet_ledger` (razón
`package_purchase`). Nunca se acredita saldo fuera del webhook o el Super Admin.

### Visibilidad
- **Tenant**: saldo siempre visible, avisos al **80 %** y **100 %** (usa el
  catálogo de notificaciones ya construido: eventos `wallet.low`/`wallet.empty`),
  compra en dos clics.
- **Super Admin**: consumo y saldo por tenant, **gasto del mes vs cobrado**, y
  **margen real por cliente** (ingreso − costo Meta − costo IA), para detectar el
  mismo día a quien cuesta más de lo que paga. (La calculadora de costos ya tiene
  las tarifas; falta cruzarlo con el consumo real por tenant.)

### Exposición máxima con la bolsa
Pasa de **ilimitada** a **≤ (saldo prepagado del tenant)**, es decir **nunca más
de lo que ya te pagó** + el fusible global como red de última instancia.

---

## 4. Lo que depende de configuración externa (pasos exactos para ti)

### Meta (línea de crédito y WABAs)
- Meta **no ofrece un tope de gasto en pesos** por WABA bajo línea de crédito
  compartida. Las palancas reales:
  1. **Límites de mensajería por número** (los controla Meta por calidad): mantén
     números nuevos en tiers bajos hasta confiar en el tenant. Revísalos en
     **WhatsApp Manager → Números de teléfono → Límite de mensajería**.
  2. **Alertas de facturación**: en **Business Manager → Configuración de pagos**,
     configura umbral de facturación y notificaciones de gasto.
  3. **Analítica de conversaciones** vía Graph API para la **reconciliación** (H3):
     `GET /{waba-id}/conversation_analytics` — compáralo con `usage_events`.
  4. Para el protocolo de desvinculación (H2): revocar la **compartición de línea
     de crédito** de la WABA en **Business Settings → Cuentas de WhatsApp →
     (WABA) → Configuración de pago** y quitar a TuBot como socio.
- **Nota de negocio (ya decidido, no lo cambio)**: no pedimos medio de pago al
  cliente en Meta; por eso la bolsa prepagada es la única barrera de plata que
  controlamos nosotros. Es correcto priorizarla.

### Railway
- Confirmar que la app corre con `DATABASE_URL` = rol **`conversia_app`** (mínimo
  privilegio, sin BYPASSRLS) y que el rol **owner** (DDL/BYPASSRLS) solo se use
  vía `DIRECT_DATABASE_URL` para migraciones. (Hoy el patrón de migración usa la
  URL pública del superusuario **solo** para `migrate deploy`; verificar que el
  runtime NO use esa URL.)
- Cargar `SUPER_ADMIN_ALLOWED_IPS` (M4).

### Pasarela
- Verificar que estén cargados los secretos de webhook (`STRIPE_WEBHOOK_SECRET`,
  Lemon Squeezy `webhookSecret`, Flow keys) — el código ya los exige. Añadir el
  cruce monto==plan (M5).

---

## 5. Plan de corrección priorizado (riesgo × esfuerzo)

### 🚧 ANTES del primer cliente pagando (bloqueantes)
| # | Acción | Riesgo | Esfuerzo | Necesita migración |
|---|---|---|---|---|
| C1/M1 | **Bolsa prepagada** con débito atómico previo en el punto único de envío | 🔴 | Alto | Sí (wallet + ledger + package) |
| H3 | **Fusible global** de gasto diario (corta envíos + alerta) | 🟠 | Medio | No (usa usage_events + Redis) |
| C2 | **Demo sin envío de plantillas** (o cupo 5) + expiración | 🔴 | Medio | Quizá (flag demo/expiración) |
| H1 | **Gracia sin plantillas** (envío solo si suscripción ACTIVE/saldo) | 🟠 | Bajo | No |
| C2 | Antiabuso registro: **verificar correo + teléfono**, 1 demo por número | 🔴 | Medio | Sí (verificación/otp) |

### 🛡️ Poco después (endurecimiento)
| # | Acción | Riesgo | Esfuerzo |
|---|---|---|---|
| H2 | Protocolo de desvinculación + alerta de WABA huérfana | 🟠 | Medio |
| H3 | Detección de anomalías por volumen + reconciliación vs Meta | 🟠 | Medio |
| M2 | Revocación de sesiones de tenant (jti denylist / tokenVersion) | 🟡 | Bajo |
| M3 | `REVOKE UPDATE,DELETE ON audit_logs` (+ trigger) | 🟡 | Bajo (migración corta) |
| M4 | `SUPER_ADMIN_ALLOWED_IPS` | 🟡 | Trivial (config) |
| M5 | Cruce monto==plan en webhook | 🟡 | Bajo |
| Super Admin | Panel: consumo/saldo/margen por tenant | 🟠 | Medio |

### 🔧 Cuando haya espacio
- L1 rate-limit fino (IA/exports/API pública), L3 revisión CSP, verificación de
  correo general, watch-paths de deploy.

---

## 6. Mitigación puente — IMPLEMENTADA (2026-08-10)

Contención inmediata, sin migración, aplicada en el **único punto de envío de
plantillas** (`apps/worker/src/messaging-guard.ts`, invocado por `outbound.ts` y
`workflow-runtime.ts` que cubren bandeja, flujos y recordatorios). **Corta solo
plantillas** (las que cuestan); las respuestas dentro de 24 h (servicio, gratis)
**no se tocan nunca**.

### Datos que fijaron los topes (prod, últimos 30 días)
Consulta de `usage_events` (plantillas facturables, `cost_usd > 0`):
- **Total plantillas 30 d: 0 · Tenants que enviaron: 0 · Pico por tenant/día: 0 ·
  Pico plataforma/día: 0.**
- Interpretación honesta: la plataforma es **pre-primer-cliente**; no hay envío
  real todavía. Con pico histórico = 0, "3× pico" daría 0 (bloquearía todo), así
  que fijo **defaults conservadores con piso**, ajustables sin redeploy.

### Topes activos (ajustables)
| Tope | Valor por defecto | Peor caso $/día | Dónde ajustar |
|---|---|---|---|
| **Por tenant / día** | **500** plantillas | ~$8.830 (util.) a ~$39.245 (mkt.) CLP por tenant | `platform_settings.messagingCapPerTenantDay` o env `MSG_CAP_PER_TENANT_DAY`; override por tenant en `org.settings.messaging.dailyCap` |
| **Fusible global / día** | **1.500** plantillas | ~$26.490 a ~$117.735 CLP plataforma | `platform_settings.messagingCapGlobalDay` o env `MSG_CAP_GLOBAL_DAY` |

> Recomendación: **recalcular a 3× el pico real** apenas haya datos (p. ej. tras el
> primer mes con clientes). Mientras, 500/1.500 acota el desastre sin estorbar un
> arranque normal (un consultorio enviando recordatorios rara vez pasa de decenas/
> día). Si un tenant legítimo topa, lo verás por la alerta y lo subes en un campo.

### Comportamiento
- **Demo (TRIAL)**: bloqueo total de plantillas. Todo lo demás (agentes, flujos,
  simulador, responder en 24 h) funciona.
- **Gracia por impago (suscripción `PAST_DUE`) y suspensión**: sin plantillas; el
  panel sigue accesible. (Cierra H1.)
- **Tope por tenant**: rechaza el envío nº N+1 del día de ESE tenant.
- **Fusible global**: al superar el techo agregado, **corta plantillas de todos**,
  marca el estado y **alerta**: `GET /health/fuse` devuelve **503** (para un
  monitor de BetterStack que te llama al teléfono) y, si `OPS_ALERT_WEBHOOK_URL`
  está configurado, hace POST inmediato al webhook. Se auto-resetea al día siguiente.
- **Visibilidad al tenant**: el mensaje bloqueado queda **FAILED** con el motivo y
  se agrega una **nota de sistema en la conversación** explicando por qué no salió.
- **WABA huérfana** (`orphan-waba-check.ts`, cada 6 h): alerta si una WABA sigue
  registrada con su tenant SUSPENDIDO/ELIMINADO. (Contención parcial de H2.)

### Config externa que debes hacer tú
1. **BetterStack**: crear un **Monitor** HTTP a `https://<api>/health/fuse` con
   escalado a **llamada telefónica** (como los otros monitores de `docs/MONITORING.md`).
   Cuando el fusible corte, el monitor lo verá "caído" y te llama.
2. (Opcional, para alerta *instantánea*) cargar `OPS_ALERT_WEBHOOK_URL` con un
   *incoming webhook* de BetterStack/Slack.
3. Ajustar los topes cuando tengas datos reales (campos de arriba).

**Falla abierta** ante errores de infraestructura (no rompe la operación por un
fallo transitorio de Redis); los bloqueos de negocio (demo/gracia) sí cierran.
Esto NO reemplaza la bolsa prepagada (Eje 1.2) — es la red mientras se construye.
