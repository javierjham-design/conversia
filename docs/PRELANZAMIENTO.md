# Auditoría de alistamiento pre-lanzamiento — TuBot / Conversia

Fecha: 2026-08-04. Alcance: ¿está el producto listo para gastar en anuncios de
Meta y vender a **cualquier rubro** (no solo clínicas)? Diagnóstico honesto, sin
construir nada. Todo verificado leyendo el repo + docs + estado real de la app de
Meta por MCP. Donde digo "no está", es que **no lo encontré implementado**.

---

## Veredicto en una línea

**Puedes lanzar campañas para construir pipeline/lista de espera, pero NO puedes
todavía prometer "conecta tu WhatsApp en minutos" a un cliente externo.** El único
bloqueo duro es el onboarding de WhatsApp de terceros (App Review en revisión). El
producto **es más neutral de rubro de lo esperado** (landing, modelos y plantillas
ya son genéricos); lo "de clínica" que queda es cosmético/legal, no estructural.
Antes del primer peso en anuncios cierra 3 cosas: **(1)** decidir qué prometes
mientras la App Review no esté aprobada, **(2)** monitoreo/alertas mínimas, **(3)**
limpiar el lenguaje "paciente/salud" de las páginas legales y la de integraciones.

---

## Resumen de bloqueo

| # | Brecha | Riesgo | Esfuerzo | Categoría |
|---|--------|--------|----------|-----------|
| B1 | Onboarding WhatsApp de terceros depende de App Review (Advanced access) **en revisión** | 🔴 Crítico | — (esperar Meta) | **BLOQUEANTE** |
| B2 | Línea de crédito compartida / OBO billing (Meta cobra a TuBot, TuBot al cliente) **no implementada** | 🔴 Alto | Alto | **BLOQUEANTE (modelo reventa)** |
| I1 | Sin monitoreo/alertas: webhook caído, worker muerto, cola atascada → **no te enteras** | 🟠 Alto | Bajo-Medio | Importante |
| I2 | Impago no suspende ni degrada; "sin plan = ilimitado" | 🟠 Alto | Medio | Importante |
| I3 | Restauración de backups **nunca probada** | 🟠 Alto | Bajo | Importante |
| I4 | Legal: copy "paciente/salud" + **sin DPA** ni DPA firmados con subprocesadores | 🟠 Alto | Bajo (copy) / legal | Importante |
| I5 | Sin MFA en cuentas owner/admin del tenant | 🟠 Medio-Alto | Medio | Importante |
| D1 | Página de Integraciones saturada de agendas dentales (Cláriva/Dentalink) | 🟡 Medio (percepción) | Bajo | Deseable |
| D2 | Sin plantillas de agente/flujo por industria | 🟡 Bajo | Medio | Deseable |
| D3 | Nombres internos y microcopy dentales (Clinic/Professional) | 🟡 Bajo | Medio | Deseable |
| D4 | `rubro` es decorativo (no adapta módulos ni plantillas) | 🟡 Bajo | Medio-Alto | Deseable |

---

## 1) Neutralidad de rubro — **mejor de lo esperado**

**Estado real:** el producto ya NO está estructuralmente casado con lo dental.

- **Landing (`tubot.cl`)**: 100% transversal. Título "Atención y ventas por
  WhatsApp con IA"; features genéricas (agentes, flujos, bandeja, reportes). Cero
  lenguaje dental. **No hay que reposicionar el mensaje** — ya está bien.
- **Modelo de datos**: `Clinic`, `Professional`, `Service`, `Appointment` son
  **genéricos en sus campos** (sede con nombre/dirección/horario; profesional con
  nombre/especialidad/`externalRef`; servicio con código/precio/duración; cita con
  contacto/servicio/profesional/inicio/fin/estado). Sirven tal cual para una
  inmobiliaria (visitas), un taller (mantenciones), un gimnasio (clases). **Lo
  único dental es el NOMBRE interno** (`Clinic`, `Professional`) — casi no se ve en
  la UI. Reutilizable sin cambio de fondo; solo renombrar de cara al usuario.
- **Módulos que sobran**: la navegación **no fuerza módulos dentales**. "Agenda"
  está como *Próximamente*; no hay pantalla de "profesionales" ni "citas" en el
  panel del tenant. El gating es por **permisos de rol**, no por rubro. Una tienda
  que solo responde consultas no ve media plataforma vacía de agenda. **Riesgo bajo.**
  Lo que **no** existe: flags de módulo por organización (activar/ocultar por
  rubro). Hoy no hace falta para el caso simple, pero lo pediría antes de rubros
  con necesidades muy distintas.
- **Integraciones de nicho**: la arquitectura de agenda es **genérica y correcta**
  — contrato `SchedulingProvider` con adaptadores (Mock, Cláriva, Dentalink,
  **Google Calendar**, **Agenda personalizada vía API con HMAC**). Un tenant **sin
  ninguna agenda conectada opera normal** (la agenda es opcional). ✔ Sumar otro
  proveedor no toca el núcleo. **El problema es de vitrina**: la página de
  Integraciones muestra Cláriva y Dentalink (ambas dentales) de forma prominente →
  un cliente de otro rubro percibe "esto es para dentistas". (Ver D1.)
- **Plantillas**: las **5 de agente** (recepcionista, agendador, calificador,
  soporte, derivador) y las **4 de flujo** (bienvenida, seguimiento sin respuesta,
  palabra clave, encuesta) son **genéricas multi-rubro** con variables
  `{{organization.name}}`. ✔ Lo que falta: **plantillas por industria** (comercio,
  inmobiliaria, educación, servicios) para que el cliente diga "esto es para mí" en
  la primera pantalla. (Ver D2.)

**Qué falta:** renombrar `Clinic→Sucursal/Sede` y `Professional→Miembro del
equipo/Recurso` en la UI; limpiar la vitrina de integraciones; plantillas por
industria; opcional: flags de módulo por org.

**Riesgo si lanzo así:** medio-**bajo de percepción**. No se siente "de clínica"
salvo que el cliente entre a Integraciones o lea las páginas legales (ver punto 7).

**Esfuerzo:** microcopy + vitrina = **bajo**; plantillas por industria = medio;
flags de módulo/rubro configurable = medio-alto.

---

## 2) Alta de un cliente nuevo — **el punto crítico**

**Cómo nace un tenant hoy:** ✔ **Self-serve real**. `POST /auth/register` crea en
una transacción: organización + roles del sistema + usuario owner + etapas del
ciclo de vida por defecto. Sin pasos manuales en BD ni variables de entorno. El
Super Admin también puede crear demos (IA pausada, vigencia, tope 0). **Esto está
bien.** Lo que un tenant nuevo **no** recibe automáticamente: un agente ni un canal
(los crea/conecta él).

**Cómo conecta SU WhatsApp una empresa externa — AQUÍ ESTÁ EL BLOQUEO:**
- El **Embedded Signup (Facebook Login for Business) está cableado** en Canales
  ("Conectar con Meta", `config_id` configurado, intercambio code→token,
  suscripción de webhooks, registro del número). La UI y el backend existen.
- **PERO** requiere que la app tenga **acceso Avanzado** a
  `whatsapp_business_messaging` + `whatsapp_business_management` +
  `business_management`. Hoy están en **acceso Estándar** (la App Review está
  **PENDING**, verificado por MCP 2026-08-04). En Estándar, **solo cuentas con rol
  en la app** (tú, testers) pueden completar el Embedded Signup. **Un cliente
  externo NO puede conectar su WABA hasta que Meta apruebe.**
- La alternativa actual (pegar token de Usuario del Sistema a mano) **no es
  aceptable** para un cliente externo, como tú mismo dijiste.

**Qué exige Meta (resumen):** ser **Tech Provider** ✔ (hecho), **verificación de
negocio** ✔ (hecha), y **App Review con acceso Avanzado** de esos permisos ⏳ (en
revisión; primera evaluación, aún sin veredicto). Además, para el modelo de reventa
sin que el cliente ponga tarjeta en Meta, hace falta la **línea de crédito
compartida (OBO)** que hoy **no está implementada** (parkeada).

**¿Puedo vender SIN eso?** Con honestidad:
- **Onboarding self-serve de WhatsApp de terceros: NO**, hasta que la App Review
  dé acceso Avanzado.
- Caminos mínimos viables mientras tanto: **(a)** campañas para **lista de
  espera/pipeline** ("resérvate el lanzamiento"); **(b)** onboarding **asistido**
  agregando al cliente como colaborador de la app (no escala, sirve para 1–5
  pilotos); **(c)** cerrar la venta y **agendar la activación** para cuando llegue
  el veredicto. Lo que **no** debes prometer en el anuncio es "conéctalo tú en
  minutos".

**Estado App Review y cobertura:** los permisos solicitados cubren mensajería +
gestión de WABA + business_management → **alcanzan para que un tercero conecte su
WABA** una vez aprobado. **`ads_read` NO está en la solicitud** → para que un
cliente conecte **sus anuncios** hará falta pedirlo aparte (o usar tu token de
sistema para tus propias campañas, que sí funciona sin review).

**Camino de un cliente nuevo — pasos que exigen que TÚ intervengas hoy:**
1. Registro (tenant vacío) → **self-serve** ✔.
2. Conectar WhatsApp → **requiere que TÚ lo habilites** (colaborador de la app) o
   esperar App Review. ❌ (paso manual bloqueante hoy).
3. Crear agente → self-serve (plantilla) ✔.
4. Publicar flujo → self-serve (con validación al publicar) ✔.
5. Primera conversación → automática ✔.
6. **Plantillas HSM** (para escribir fuera de 24 h) → **el cliente las crea en Meta**
   y espera aprobación (paso externo, guía parcial — ver punto 6).

→ **1 paso manual bloqueante (el #2)** hasta la aprobación. El resto es self-serve.

**Riesgo si lanzo así:** alto — si el anuncio promete autoservicio y el cliente no
puede conectar su número, quema confianza y presupuesto.

**Esfuerzo:** App Review = esperar (0 dev). OBO billing = alto. Onboarding asistido
para pilotos = bajo.

---

## 3) Cobro y planes

**Checkout Flow (CLP):** ✔ **funciona de punta a punta**. `POST
/billing/webhooks/flow` consulta `getStatus` firmado, verifica pago (status=2),
dedup, y **activa solo**: pone la suscripción `ACTIVE`, la org `ACTIVE`, fija
`periodEnd` y emite una factura `PAID` numerada. Requiere credenciales Flow cargadas
(Super Admin) y la URL del webhook registrada en Flow. Lemon Squeezy (USD) y Stripe
también cableados.

**¿Los límites se aplican de verdad?** ✔ **Sí, server-side.** `enforcePlanLimit`
niega con **403** al alcanzar el tope de `agents/channels/workflows/users` (cuenta
dentro de la transacción). El **tope diario de tokens de IA** se agrega y **corta
antes** de generar el turno. **Peros importantes:**
- **"Sin suscripción activa o límite 0 ⇒ ILIMITADO"** (regla explícita para no
  romper el tenant semilla). Un tenant sin plan **no tiene límites**.
- **No hay dunning ni suspensión por impago**: `activate` fija `periodEnd`, pero
  **nada degrada ni suspende** cuando vence sin renovar. La `validUntil` (vigencia)
  solo se aplica a **demos** (ahí sí: agentes bloquean IA si expiró o si la org está
  `SUSPENDED/CANCELLED`). Para clientes de pago, si dejan de pagar, **el bot sigue
  andando** hasta que suspendas a mano en el Super Admin.

**Estructura de límites para otros rubros:** pensada para volúmenes tipo clínica.
Un e-commerce puede tener 10× conversaciones → el cuello real no es "agentes/flujos"
sino **conversaciones + tokens de IA**. El tope de tokens/día existe; faltan
**topes/alertas de volumen de conversaciones** y planes calibrados por consumo real.

**Facturación (fuera de alcance):** la **facturación tributaria en Chile ya está
resuelta FUERA de la plataforma**, asociada al método de pago. El `CONV-2026-000001`
del sistema es **solo registro operativo**, no un documento tributario. **No es una
brecha** y no debe volver a listarse como tal.

**Riesgo:** medio. Cobras bien, pero no auto-suspendes morosos. Manejable con
supervisión manual para los primeros clientes.

**Esfuerzo:** dunning-lite (suspender al vencer `periodEnd`) = medio; DTE = externo.

---

## 4) Aislamiento y seguridad con muchos clientes — **fortaleza**

**Estado real (verificado en docs de seguridad + código):**
- **Multi-tenant**: RLS por `organization_id` en **todas** las tablas vía
  `sql/setup.sql` **dinámico** (aplica política a cualquier tabla con esa columna →
  las tablas nuevas como `meta_ads` la heredan; verifiqué que se aplicó con RLS).
  Cliente dual: rol `conversia_app` **sin BYPASSRLS**; admin solo para
  registro/login/ruteo. Verificador de aislamiento **en CI** (job
  `tenant-isolation`). `organizationId` **jamás** desde el cliente (JWT/canal).
  **Veredicto: aprobado.** Es lo más sólido del producto.
- **Colas BullMQ**: cada job lleva `organizationId` y el worker reabre `withTenant`.
- **Secretos**: tokens de terceros (Meta/Cláriva/Google/HubSpot), credenciales de
  integración y de agenda → **cifrados AES-256-GCM en reposo**, nunca al frontend,
  descifrado solo server-side. **appsecret_proof** firmado en todas las llamadas a
  Graph (recién desplegado). **Falta:** KMS / rotación de clave (clave única).
- **Datos sensibles**: se almacenan mensajes y transcripciones de audio (Whisper).
  Si una cuenta de usuario se ve comprometida **sin MFA**, el atacante ve la bandeja
  completa de ese tenant. **MFA no existe** (R-10, residual Alto).

**Qué falta:** MFA (owner/admin), rotación de secretos/KMS, anti-replay en webhooks,
retención/borrado configurable (ver punto 7).

**Riesgo:** el aislamiento es fuerte; el flanco real es **cuentas sin MFA** y la
**ausencia de auditoría externa** (el propio doc dice "requiere pentest antes de uso
masivo con datos reales").

**Esfuerzo:** MFA = medio; pentest = externo.

---

## 5) Operación y confiabilidad — **el punto más flojo para producción**

- **Monitoreo/alertas: prácticamente NO hay.** Solo un endpoint `/health` de
  liveness. **No hay Sentry, uptime monitor, ni alertas** de webhook caído, cola
  atascada, worker muerto, integración en error o tasa de fallos de envío. La tabla
  `system_alerts` existe en el esquema pero **el panel/alertado está pendiente**.
  **Si algo se cae a las 2 AM, no te enteras.** → **el hueco operativo más grande.**
  *Mínimo viable:* UptimeRobot/BetterStack pinstruyendo `/health` (gratis–bajo) +
  Sentry en api/worker (plan gratis) + una alerta si la cola supera N o el worker no
  late. Costo: **~US$0–30/mes**. Esfuerzo bajo.
- **Backups**: automáticos gestionados por Railway, **pero la RESTAURACIÓN nunca se
  probó** (R-17, EXC-02 vencida). *Cómo probarla sin tocar prod:* `pg_dump` del
  público → restaurar en una BD Postgres **nueva y separada** (Railway efímero o
  local) → correr smoke (conteos, login, una conversación). No toca producción.
- **Rendimiento/costos con escala:** hoy ~3.700 contactos de 1 tenant. Con 10–50
  empresas (incl. alto volumen):
  - **Consultas**: la mayoría filtra por `organizationId` con índices por
    `(org, ...)`; el riesgo son listados de bandeja/contactos con filtros combinados
    → revisar índices antes de rubros de alto volumen.
  - **Costo Railway**: Postgres+Redis+api+worker+web; escala vertical hasta cierto
    punto — el worker (IA + colas) será el primero en pedir más.
  - **Costo IA por tenant**: hay `usage_events` con costo por turno y tope diario;
    modelo por defecto **opus-4-8** es caro para clasificación masiva → para
    e-commerce conviene bajar a haiku por defecto.
  - **Límite de WhatsApp por número**: tier de mensajería de Meta (1K/10K/100K/día)
    por número; un e-commerce puede toparlo → hay que vigilar el escalado de tier.
- **Degradación si cae Meta o la IA:** parcial. La IA tiene Mock/fallback y kill
  switch; los envíos fallidos marcan FAILED sin reintento infinito. **No hay
  circuit breaker global** ni página de estado. Si Graph cae, los envíos fallan
  hasta que vuelva (no se cae todo, pero no degrada "elegante").

**Riesgo:** alto para clientes de pago — **la falta de alertas es lo que más
duele**.

**Esfuerzo:** monitoreo mínimo = **bajo** (horas); prueba de restauración = bajo.

---

## 6) Experiencia del cliente

- **Día uno con ojo de cliente nuevo:** el panel tiene **checklist de puesta en
  marcha** (WhatsApp → agente → flujo) y banners de "conectar WhatsApp". Robustez
  ante datos vacíos ya trabajada (pantallas no se rompen en tenant vacío). Bien como
  base.
- **Onboarding guiado / ayuda:** hay ayuda contextual por sección en el editor de
  agentes y textos de apoyo, **pero no hay un tour guiado ni glosario** para el no
  técnico. **Alguien que no sabe qué es un "workflow"/"flujo" se queda sin brújula.**
  Falta: onboarding paso a paso + microcopy que explique "flujo = automatización".
- **Reporte de problemas:** **no hay** botón de soporte/ticket in-app ni forma de
  que el cliente te escriba desde el panel; tú ves incidencias técnicas por la
  **campana de `integration_events`**, no reportes del usuario. Falta un canal de
  soporte (aunque sea un WhatsApp/enlace).
- **Plantillas de WhatsApp (HSM):** hay panel de plantillas con **estado de
  sincronización** y sync cada 6 h; el nodo "Enviar plantilla" valida que esté
  aprobada. **Falta guía con textos sugeridos** para que el cliente cree las suyas
  en Meta (hoy debe adivinar el formato/among categorías). Parcial.

**Riesgo:** medio — no bloquea, pero sube el costo de soporte y la tasa de abandono
de clientes no técnicos.

**Esfuerzo:** onboarding guiado + canal de soporte = medio.

---

## 7) Legal y cumplimiento — **riesgos, no asesoría**

- **Documentos:** existen **Términos**, **Privacidad** y **Eliminación de datos**,
  **enlazados en el footer de la landing** ✔. La privacidad ya modela bien el rol:
  **TuBot = encargada del tratamiento (processor)**, el tenant = responsable
  (controller). **Peros:**
  - El copy legal usa **"pacientes" y "datos sensibles de salud"** → **sabe a
    dental**. Hay que neutralizarlo ("contactos/usuarios finales") para vender
    transversal. (Contribuye a la percepción "de clínica".)
  - **No hay DPA (acuerdo de tratamiento de datos) para tus clientes** como
    documento aparte, ni constancia de **DPAs firmados con subprocesadores**
    (Anthropic, OpenAI, Meta) — hay un TODO explícito sin marcar en
    `PUESTA_EN_MARCHA.md`.
- **Normativa chilena (Ley 19.628 y la reforma Ley 21.719 de protección de datos,
  que endurece con multas y crea la Agencia):** vas a tratar datos personales de
  clientes de terceros y, en algunos rubros, **datos sensibles** (salud,
  financieros). Puntos que la ley toca y que **hoy NO están cubiertos por
  producto**: **consentimiento** demostrable del usuario final; **retención**
  definida y **borrado** configurable; **notificación de incidentes** a la Agencia y
  a afectados; contrato **responsable–encargado** con cada cliente.
- **Retención/borrado configurable de conversaciones y transcripciones:** **no
  existe** política de retención ni purga automática de mensajes/transcripciones
  (sí hay purga de *exports* a 7 días). Un cliente que pida "borra los datos de este
  contacto" no tiene un mecanismo de borrado completo garantizado.

> ⚖️ **Consultar con abogado (no resolver con código):** redacción del DPA y de los
> Términos, base de licitud/consentimiento para datos sensibles, obligaciones de
> notificación de incidentes bajo la Ley 21.719, y si tu rol de "encargado" te
> exige medidas específicas por rubro (salud/financiero). El producto debe **dar el
> mecanismo** (consentimiento, retención, borrado); la **redacción y la
> interpretación legal** son del abogado.

**Riesgo:** alto si entras a rubros con datos sensibles sin DPA ni borrado.

**Esfuerzo:** neutralizar copy = bajo; mecanismo de retención/borrado = medio;
DPA/consulta legal = externo.

---

## 8) Lo comercial

- **Landing pública + precios:** ✔ existe `tubot.cl`, transversal, con **precios en
  vivo** desde `/public/plans` (fallback si la API no responde) y CTA de demo.
- **Posicionamiento:** ✔ **ya transversal**, no dental. **No hay que cambiar el
  mensaje** de la landing. (El sabor dental sobrevive en Integraciones y en las
  páginas legales, no en el pitch.)
- **Demo/trial:** ✔ hay **flujo de demo** (org con IA pausada, vigencia, tope 0) y
  plan **Free** ("para probar"). La vigencia del demo **sí se aplica** (los agentes
  bloquean IA si expiró o la org está suspendida). Mostrable en una reunión sin
  exponer datos reales (tenant demo aislado).

**Riesgo:** bajo. Lo comercial es de lo más listo.

---

## Recomendación honesta

**¿Puedo lanzar campañas ahora?** Depende de qué prometas:

- **SÍ puedes** lanzar campañas para **generar demanda/lista de espera** y cerrar
  ventas con **activación asistida** (tú habilitas el WhatsApp del piloto). Con eso
  ya validas mensaje, precio y rubros — sin quemar la promesa de autoservicio.
- **NO deberías** prometer "conecta tu WhatsApp solo, en minutos" hasta que la **App
  Review dé acceso Avanzado** (B1). Es el único bloqueo duro y **no depende de más
  código, sino del veredicto de Meta**.

**Cierra sí o sí antes del primer peso en anuncios (barato y rápido):**
1. **Monitoreo mínimo** (I1): uptime a `/health` + Sentry + alerta de cola/worker.
   Sin esto, el primer cliente de pago es una ruleta.
2. **Neutralizar el lenguaje** "paciente/salud" en las **páginas legales** y ordenar
   la **vitrina de Integraciones** (I4, D1). Es copy: horas, no días. Evita que el
   cliente sienta que entró a un software dental.
3. **Definir el guion del anuncio** acorde a B1 (waitlist/activación asistida, no
   autoservicio pleno).

**Para los primeros 5 clientes (semanas siguientes):** dunning-lite/suspensión por
impago (I2), prueba de restauración de backup (I3), MFA (I5), mecanismo de
retención/borrado + DPA con asesoría legal (punto 7), onboarding guiado + canal de
soporte (punto 6).

**Deseable después:** plantillas por industria, flags de módulo por rubro, renombrar
entidades internas.

**¿Se siente "de clínica"? — sin diplomacia:** **No de forma estructural.** La
landing, los modelos, los agentes y los flujos ya son genéricos, y la agenda es
opcional. El olor dental sobrevive en **tres lugares visibles**: la página de
**Integraciones** (llena de agendas dentales), las **páginas legales**
("paciente/salud") y el hecho de que **no hay plantillas por industria** que le
digan al cliente "esto es para tu rubro". Son arreglos **cosméticos/de contenido, no
de arquitectura** — se cierran en días, no en meses. Si limpias esos tres puntos, un
gimnasio o una inmobiliaria **no** se van a sentir fuera de lugar. Lo que de verdad
te frena para vender no es el rubro: es **poder conectar el WhatsApp del cliente**
(App Review) y **enterarte si algo se cae** (monitoreo).
