# CONVERSIA.CL — LINEAMIENTO ESTRATÉGICO DE VERTICALIZACIÓN

**Fecha:** 2026-09-30
**Estado:** LINEAMIENTO PARA DECISIÓN — nada construido, nada publicado
**Idea:** usar el dominio conversia.cl para vender la misma plataforma (monorepo `conversia`) como **producto completo por nicho** — "sistema de administración + bot incluido" para barberías/peluquerías, clínicas dentales, ferreterías, venta de servicios — en vez del enfoque genérico probado con TuBot.

---

## 0. VEREDICTO EN UNA LÍNEA

La idea es viable y la plataforma está **más cerca de lo que parece**: ya existe una capa de "rubro" (vocabulario, módulos, plantillas sugeridas), seeds JSON que son de facto plantillas de tenant completo, agenda nativa genérica, catálogo, CRM y cobro recurrente. Lo que NO existe es (1) un **paquete vertical instalable** al registrarse, (2) **white-label/multi-dominio** (todo está hardcodeado como TuBot), y (3) **contenido real por nicho**. La regla de oro: **un solo código, N paquetes de datos** — jamás un fork por vertical.

---

## 1. QUÉ HAY HOY (auditado 2026-09-30)

### Listo y aprovechable

| Capacidad | Estado | Dónde |
|---|---|---|
| Multi-tenant con RLS + verificador en CI | ✅ Producción | `packages/database` |
| Registro autoservicio + prueba 7+7 + plan Free | ✅ | `POST /auth/register`, `trial-lifecycle.ts` |
| Cobro recurrente Flow + bolsa prepagada + suspensión | ✅ | `apps/worker/src/subscription-billing/` |
| Capa de rubro: 9 industrias, vocabulario, módulo agenda | ✅ parcial | `apps/api/src/common/industries.ts` |
| Plantillas de flujo por rubro (instalables como borrador) | ✅ parcial | `apps/web/src/lib/industry-templates.ts` |
| Guía HSM por rubro con vocabulario aplicado | ✅ | `apps/api/src/organizations/template-guide.ts` |
| Agenda nativa (recursos, servicios, anti doble reserva, recordatorios) | ✅ con huecos | `packages/scheduling` |
| Catálogo normalizado + Bsale/Jumpseller/Woo/Shopify/Fudo/CSV | ✅ | `docs/CATALOGS.md` |
| CRM configurable (etapas, campos, etiquetas, segmentos, roles) | ✅ | schema Prisma |
| Cobros del tenant a sus clientes (Flow/Getnet, tool `enviarLinkDePago`) | ✅ | `apps/api/src/charging/` |
| Montaje asistido por IA con grant auditado (TB-XXXX) | ✅ parcial | `docs/TUBOT_TENANT.md` §7 |
| Seeds JSON = plantilla de tenant completo (solo por CLI) | ✅ formato | `packages/database/seeds/`, ADR-12 |
| Omnicanal WhatsApp + Instagram + Messenger | ✅ | `docs/OMNICHANNEL.md` |
| Cláriva y Dentalink como proveedores de agenda (dental) | ✅ | `packages/scheduling` |

### Brechas principales

1. **Paquete vertical instalable**: el registro no pregunta rubro; nada se instala solo. Las plantillas de agentes/flujos viven escritas a mano en el **frontend** (`agent-templates.ts`, `workflow-templates.ts`); la tabla `AgentTemplate` (tiene columna `industry`) existe pero **no se usa**.
2. **White-label inexistente**: ~230 referencias a "tubot" en el código; `tubot.cl` literal en 19 archivos (correos, MFA issuer, asuntos de pago, legales, manifest, logos). `OrganizationDomain` existe en el schema pero sin uso. Un solo `WEB_URL` para CORS, OAuth, Flow y correos. El flag `whiteLabel` del plan Pro no tiene ningún efecto.
3. **Contenido vertical real**: no hay rubro "barbería", ni "ferretería", ni "dental" como tal (hoy cae en "salud"). Las 5 plantillas de flujo "Dental" existen pero ningún rubro las recomienda.
4. **Agenda nativa incompleta**: reagendar, cancelar y confirmar lanzan "aún no disponible" — crítico para barberías/peluquerías.
5. **Sin "admin" completo para algunos nichos**: no hay pedidos, stock, cotizaciones ni caja/comisiones. Ferretería hoy solo se cubre a medias (catálogo + cotización + link de pago, sin orden de compra).
6. **Operación**: sin prueba de carga, sin verificación de correo en el registro (antiabuso), `RELIABILITY.md` dice "aún no listo para lanzar" masivamente.

---

## 2. CONCEPTO PROPUESTO: UNA PLATAFORMA, N VERTICALES

**Definición de "vertical" = paquete de datos versionado**, nunca código. Cada vertical empaqueta:

- Vocabulario (ya existe: `industries.ts`)
- Módulos activos (agenda, catálogo, cobros, difusiones — hoy solo `agenda` es activable)
- Etapas del embudo + campos personalizados + etiquetas del rubro
- Servicios/recursos de ejemplo (el "menú" típico de una barbería, aranceles dentales, etc.)
- Agentes con prompt del nicho, **publicables** (no solo sugeridos)
- Flujos del nicho (recordatorio no-show, reactivación, cotización, post-venta)
- Base de conocimiento inicial (FAQ del rubro)
- Guía de plantillas HSM del rubro
- Horarios típicos por defecto
- Plan/precio recomendado

**Mecanismo:** reutilizar el formato de `seed.ts` (ya carga org, sedes, equipos, etapas, servicios, profesionales, etiquetas, agentes, flujos, conocimiento, canal) pero ejecutable **desde la API en una transacción**, disparado por:
- el registro (`?vertical=barberia` desde la landing), y
- el Super Admin ("crear tenant desde plantilla"), y
- una tool del montaje asistido (`installVerticalPackage`).

Las plantillas se mueven del frontend a BD (revivir `AgentTemplate` o crear `vertical_templates` con JSON versionado, mismo patrón que `WorkflowVersion`).

---

## 3. DECISIÓN DE MARCA (la primera que hay que tomar)

> **ACTUALIZACIÓN 2026-09-30:** Javier decidió que TuBot queda como está y Conversia será un producto nuevo con interfaz propia en otro dominio. Es decir, se toma la vía de dos marcas, pero resuelta como **un backend compartido + frontend nuevo** — no como multi-dominio white-label genérico. El análisis técnico de cómo montarla está en `CONVERSIA_MONTAJE.md`. Las opciones de abajo quedan como registro de la deliberación.

Tres opciones, de menor a mayor esfuerzo:

**Opción A — Conversia como marca comercial única (recomendada).**
Conversia.cl pasa a ser LA marca de la plataforma con sub-propuestas por nicho ("Conversia para barberías", "Conversia Dental"…). TuBot.cl queda como landing/alias que redirige o se mantiene como marca del bot dentro del producto. Un solo Business de Meta, una sola app, un solo panel. El renombre interno es barato porque el código ya se llama `conversia` (`@conversia/*`, repo GitHub `javierjham-design/conversia`).
*Costo:* renombrar strings/branding del panel y correos (1 dominio nuevo en `WEB_URL`, manifest, logos, legales). Sin multi-dominio real.

**Opción B — Dos marcas conviviendo (TuBot genérico + Conversia verticales).**
Requiere resolución de marca por host (usar `OrganizationDomain` o tabla `Brand`), CORS múltiple, correos/remitente/MFA issuer/asuntos de pago parametrizados, legales por marca, y decidir qué app de Meta muestra el Embedded Signup. Es el verdadero "white-label" y es la brecha #2 completa.
*Costo:* alto. Solo se justifica si TuBot ya tiene clientes pagando que no quieres tocar.

**Opción C — Conversia como marca blanca por vertical (BarberBot.cl, DentalBot.cl…).**
Multiplica dominios, apps, verificaciones de Meta y mantenimiento de marketing. **Descartada** para esta etapa: es la trampa clásica de dispersión.

> Sugerencia: **A ahora, B después** solo si un vertical despega tanto que amerita marca propia. La decisión de Meta importa: las apps actuales ("CONVERSIA" y "TuBot CRM") cuelgan del Business verificado de Digital-Dent Temuco; a mediano plazo conviene un Business propio de Conversia.

---

## 4. NICHOS: POR CUÁL EMPEZAR

Criterio: dolor claro + la plataforma ya lo cubre + ticket alcanzable.

| Nicho | Fit técnico hoy | Falta | Prioridad |
|---|---|---|---|
| **Clínicas dentales** | ⭐⭐⭐ Cláriva + Dentalink + plantillas Dental + experiencia Digital-Dent real | Rubro "dental" propio, empaquetar lo aprendido | **1** |
| **Barberías/peluquerías** | ⭐⭐ Agenda nativa + recordatorios + no-show | Reagendar/cancelar/confirmar nativos, caja/comisiones (v2) | **2** |
| **Venta de servicios** (gásfiter, técnicos, estética, profesionales) | ⭐⭐ Agenda + CRM + cotización + link de pago | Contenido del rubro | **3** |
| **Ferreterías/comercio** | ⭐ Catálogo + cotización | Pedidos, stock, cotización formal — no existen | **Postergar** |

Lanzar con **máximo 2 verticales** (dental + barberías). Cada vertical nuevo cuesta: contenido (prompts, flujos, FAQ, HSM), landing, campañas, y conocimiento de dominio para soporte. La dispersión mató más SaaS que la competencia.

**Dental es el caballo ganador:** ya tienes un cliente real en producción (Digital-Dent), pipeline de ads probado (Instant Form → CRM → CAPI, EMQ 9+), Cláriva como "sistema de administración" del combo, y prompts validados. El paquete dental es casi "exportar lo que ya funciona".

---

## 5. FASES ANTES DE PRODUCCIÓN

### Fase 0 — Prerrequisitos que no esperan (independientes de Conversia)
- ⚠️ **HOY vence A3**: decisión OBO vs tarjeta del cliente — desde el 1-oct Meta cobra mensajes de servicio y corta entrega a WABAs sin medio de pago (`docs/PROMPTS_SERVICIO_OCT2026.md` E1–E5).
- Verificación de correo en el registro (antiabuso) — sin esto, landings con tráfico pagado generan basura.
- W-2: devolver crédito de bolsa si el envío falla.
- Prueba de carga básica + resumen automático de conversación (`RELIABILITY.md`).

### Fase 1 — Motor de paquetes verticales (backend, sin marca aún)
- Tabla `vertical_templates` (o revivir `AgentTemplate`) con JSON versionado.
- Endpoint transaccional `installVerticalPackage(orgId, verticalKey, version)` reutilizando la lógica de `seed.ts`.
- Registro con selección de rubro (`registerSchema` + `?vertical=` en `/registro`).
- Checklist de onboarding consciente del vertical.
- Mover plantillas de agentes/flujos del frontend a BD.

### Fase 2 — Contenido de los 2 verticales piloto
- Rubros nuevos en `industries.ts`: `dental`, `barberia` (con vocabulario fino).
- Paquete dental: destilar de Digital-Dent (prompts, flujos, etapas, FAQ) **sin datos del cliente**.
- Paquete barbería: requiere cerrar reagendar/cancelar/confirmar en la agenda nativa primero.
- Guías HSM por vertical.

### Fase 3 — Marca Conversia (opción A)
- conversia.cl: landing principal + `/dental` y `/barberias` con registro directo (`?vertical=`).
- Rebranding del panel, manifest, correos, legales (neutros, con anexo salud para dental).
- `WEB_URL` → conversia.cl; tubot.cl redirige o queda como landing alternativa apuntando al mismo registro.
- Business/app de Meta: evaluar migración gradual fuera del Business de Digital-Dent.

### Fase 4 — Venta y validación
- Tenant "Conversia" (o reusar el de TuBot renombrado) con agentes comerciales **por vertical** — el montaje asistido ya existe; ampliarlo con `installVerticalPackage` y los alcances declarados (flujos, servicios, conocimiento).
- Campañas Meta por vertical reutilizando el playbook de `TUBOT_META_ADS_PLAN.md` (Instant Form → WhatsApp con el bot del vertical como demo).
- Meta: 5 clientes pagando por vertical antes de abrir el tercero.

---

## 6. PROS Y CONTRAS

### Pros
1. **CAC menor y conversión mayor**: "software para barberías con bot incluido" vende más que "bot de WhatsApp genérico" — el aprendizaje directo del experimento TuBot.
2. **Pricing por valor**: un paquete vertical completo justifica los $69.900–119.900 mejor que "un bot".
3. **Demo instantánea por nicho**: el lead habla con el bot de SU rubro (ya validaste este patrón con TuBot).
4. **Menos montaje por cliente**: el paquete instala el 80%; el bot de implementación solo personaliza. Baja el costo Opus por alta (~$594 CLP hoy) y el cuello de botella humano.
5. **Reutilización total**: un código, un despliegue, un equipo. Casi todo el trabajo es contenido + un motor de instalación.
6. **Defensa competitiva**: los bots genéricos (y los wrappers de la API de WhatsApp) no traen embudo, agenda, catálogo ni cobros del rubro.
7. **Dental sale casi gratis**: Digital-Dent + Cláriva + plantillas existentes.

### Contras / riesgos
1. **Dispersión de marketing**: cada vertical = landing + campañas + creativos + contenido + soporte con conocimiento del rubro. Con más de 2–3 nichos simultáneos, un equipo de una persona se quiebra.
2. **White-label real es caro**: si se quiere panel/dominio/correo por marca (opción B), son semanas de trabajo en un área hoy 100% acoplada a TuBot.
3. **"Sistema de administración completo" promete de más** en algunos nichos: sin pedidos/stock/caja, ferretería y retail quedan cojos — no prometer lo que el producto no hace.
4. **Dos marcas activas confunden** (TuBot vs Conversia) si no se define rápido cuál manda; duplican Business de Meta, verificaciones y legales.
5. **Costo de mantención del contenido**: los paquetes verticales envejecen; cada mejora del producto obliga a revisar N plantillas.
6. **Riesgos de plataforma pre-escala** siguen ahí: sin prueba de carga, sin KMS, sin rate limit de borde, sin pentest — escalar de 2 a 50 tenants pequeños los expone.
7. **Dependencia de Meta**: costos de mensajes cambiando (1-oct), App Review por permisos nuevos, verificación de negocio por cliente sigue siendo el paso lento del onboarding.

---

## 7. SUGERENCIAS ADICIONALES

1. **No renombres nada hasta cerrar Fase 1**: el motor de paquetes funciona igual bajo marca TuBot; probar el paquete dental con la marca actual des-riesga el rebranding.
2. **Precio por vertical, no por features**: mismo motor de planes, pero `priceClp` y límites por vertical (hoy los planes son globales — brecha E4 de versionado de planes ayuda aquí).
3. **El seed de Digital-Dent es tu mejor activo**: destílalo en el paquete dental genérico. Cuidado con no filtrar datos/precios del cliente real.
4. **Usa el embudo demo existente**: `POST demo-leads/:id/provision` del Super Admin puede evolucionar a "provisionar demo del vertical X" — demos pre-armadas por nicho para vender.
5. **Conversia + Cláriva como combo dental**: "administración clínica (Cláriva) + recepcionista IA (Conversia)" es una propuesta que ningún competidor local tiene — y ambas son tuyas. Empaqueta el combo comercialmente.
6. **Métrica norte por vertical**: tiempo-hasta-primer-valor (registro → primera conversación real atendida por el bot). El paquete vertical existe para bajar ese número a minutos.
7. **Documenta la decisión como ADR** en `docs/DECISIONS.md` cuando definas marca y alcance (patrón ya establecido en el repo).

---

## 8. PRÓXIMOS PASOS INMEDIATOS

1. ✅ Resolver A3 (OBO/cobro de servicio) — vence hoy, bloquea todo lo demás.
2. Decidir marca: opción A (Conversia única) vs B (dos marcas). Recomendación: **A**.
3. Elegir los 2 verticales piloto. Recomendación: **dental + barberías**.
4. Pedir el prompt de desarrollo de la Fase 1 (motor de paquetes verticales) — se puede redactar por etapas estilo `PROMPTS_SERVICIO_OCT2026.md`.
