# CONVERSIA — MODELO DE COSTOS, CUOTAS Y PLANES

**Fecha:** 2026-09-30
**Decisiones ya tomadas (Javier):** dos marcas (TuBot autoservicio / Conversia llave en mano) · entrada agresiva de precios con capacidad de ajuste futuro · Chile + LATAM desde el inicio · migración entre marcas en ambas direcciones · **cobro de implementación obligatorio además de la mensualidad** · planes con cuota incluida de mensajes/uso y cobro de excedente (misma figura que el excedente de contactos y la bolsa prepagada que ya existen en la plataforma).
**Objetivo:** que ningún plan pueda quedar bajo el agua por consumo, y que el excedente siempre se cobre con margen.

---

## 0. TABLA RESUMEN DE COBROS (para revisión y ajuste — 2026-09-30)

### Conversia (por cliente)

| # | Concepto | Cuándo se cobra | Precio Chile (+ IVA) | Precio LATAM (USD) | Qué incluye / regla |
|---|---|---|---|---|---|
| C1 | **Setup de implementación** | Una vez, al contratar, por local/sede | Lanzamiento **$190.000** · regular $290.000 · dental c/ Cláriva o Dentalink $290.000 lanz. / $390.000 reg. | ~USD 199–299 | Configuración completa por el equipo (agentes, flujos, agenda, catálogo, alta WhatsApp/Meta). Obligatorio — no se vende mensualidad sin setup |
| C2 | **Plan Funcionando** | Mensual | **$149.900** | ~USD 159 | 1.500 créditos de mensajes + IA conversacional **sin tope comercial** (se regula sola por los créditos) + mantención reactiva (3 solicitudes de cambio/mes, SLA 48h). Permanencia 6 meses (o setup regular sin permanencia) |
| C3 | **Plan Gestionado** | Mensual | **$299.900** | ~USD 319 | 4.000 créditos + IA sin tope comercial + revisión proactiva mensual, ajuste de prompts, reporte de resultados, 1 difusión gestionada/mes (hasta 500 contactos; créditos aparte). Permanencia 6 meses |
| C4 | **Plan Custom** | Mensual, a cotización | **A cotización** (referencia: desde ~$499.900) | Desde ~USD 529 | Para mayores requerimientos: multi-sede, volúmenes altos de mensajes, integraciones a medida, difusiones mayores, SLA preferente. Créditos, servicio y setup a medida; contrato propio |
| C5 | **Sobre de créditos** (excedente — único cobro extra) | Al agotar los créditos del plan | **$21.900 / 500 créditos** (≈ $43,8/crédito; ajustado 2026-09-30, antes $29.900/1.000) | ~USD 23 | Débito por envío según peso: utilidad 1 · servicio 1 · auth 1 · **marketing 4**. Aviso al 80% y antes de facturar el sobre. Varios sobres seguidos → proponer upgrade (o Custom) |
| C6 | **Add-ons cotizados** | Puntual | A cotización | — | Sede adicional, difusiones extra gestionadas, integraciones fuera del paquete vertical. Frontera anti scope-creep: lo que no está en el paquete, se cotiza |

> **Simplificación 2026-09-30 (decisión Javier):** en Conversia NO hay cupo comercial de conversaciones IA ni cobro extra por IA — es un servicio completo. El consumo se regula solo por los **créditos de mensajes**: cada respuesta del bot (servicio, sobre las 1.000 gratis de Meta), plantilla de utilidad o marketing descuenta créditos, así que los créditos acotan naturalmente la actividad del bot (≈8 respuestas por conversación ⇒ 1.500 créditos ≈ 300 conversaciones; 4.000 ≈ 600–650). Requisito operativo: **contador de mensajes/créditos visible y confiable en la cuenta** (saldo, consumo del mes, proyección) — el dato ya existe en `MessageWallet`/`WalletLedger`; falta el widget en el panel Conversia. Resguardo interno (no comercial, invisible al cliente): el tope diario de tokens por tenant del Super Admin sigue activo como fusible anti-abuso.

### TuBot

**Decisión 2026-09-30: los planes de TuBot quedan como están (en producción, sin cambios).** Las ideas de ajuste por costo de servicio que se evaluaron aquí se archivan; solo se monitoreará el costo real de servicio por tenant cuando el medidor E1–E5 esté activo, y se revisará únicamente si el margen lo exige.

### Costo para nosotros por plan, a consumo pleno de las cuotas (Chile, CLP, IA = gpt-4o-mini ~$5/conversación)

Base del cálculo: 1 crédito ≈ 1 mensaje utilidad/servicio ($17,66–19) o ¼ de marketing ($78,49/4 = $19,62) → costo por crédito consumido ≈ **$19** (peor caso ponderado $19,6). Pasarela Flow ~3,2% + IVA sobre la mensualidad. Infra marginal ~$3.000/tenant.

| Plan / ítem | Ingreso | Meta (créditos × $19) | IA (4o-mini) | Pasarela | Infra | Labor | **COGS total** | **Margen bruto** |
|---|---|---|---|---|---|---|---|---|
| **Conversia Funcionando** | $149.900 | 1.500 cr → $28.500 | ~$1.600 (≈300 conv implícitas en los créditos) | ~$5.700 | $3.000 | ~$15.000 (1h reactiva) | **~$53.800** | **~$96.100 (64%)** |
| **Conversia Gestionado** | $299.900 | 4.000 cr → $76.000 | ~$3.300 (≈650 conv implícitas) | ~$11.400 | $3.000 | ~$60.000 (4h gestión) | **~$153.700** | **~$146.200 (49%)** |
| **Conversia Custom** (ref. $499.900) | $499.900 | a medida (regla: créditos ≤ 35% del precio) | proporcional | ~$19.000 | $3.000 | según contrato | a medida | **objetivo ≥45%** |
| **Sobre 500 créditos** | $21.900 | $9.500 (peor caso $9.800) | — | ~$830 | — | — | **~$10.330** | **~$11.600 (53%)** |
| **Setup Conversia (lanzamiento)** | $190.000 | — | bot Opus ~$600 | ~$7.200 | — | 4–6h → $60.000–90.000 | **~$68.000–98.000** | **~$92.000–122.000 (48–64%)** |

> **Decisión 2026-09-30:** los planes de TuBot no se tocan (ya están OK y en producción) — este documento queda enfocado solo en Conversia. El único punto TuBot que sigue vivo es operativo, no comercial: cuando el medidor de servicio (E1–E5) esté activo, monitorear el costo real de mensajes de servicio de los tenants TuBot y revisar solo si el margen lo exige.

**Notas del cálculo:**
1. Es el escenario de **consumo pleno** (el cliente gasta el 100% de sus cuotas). El consumo real promedio será menor → estos márgenes son el **piso**, no el promedio.
2. **El supuesto IA = gpt-4o-mini es el piso de costo, no la recomendación de calidad.** Si el vertical exige mejor modelo, el costo IA por plan sube así: Funcionando 300 conv → haiku $6.000 · sonnet $19.500 · opus $31.500; Gestionado 800 conv → haiku $16.000 · sonnet $52.000 · opus $84.000. Con sonnet, Funcionando queda en ~52% y Gestionado en ~33% — todavía sobre agua. El modelo se fija por agente/tenant desde el Super Admin, así que se puede partir con 4o-mini y subir solo donde la calidad lo pida (p. ej. dental).
3. En LATAM barato (Colombia, México) el costo Meta por crédito cae a $0,7–7,5 → los mismos planes rinden márgenes muy superiores; Argentina (utilidad $22,96) es el único país que empeora levemente el costo por crédito.
4. El pack de créditos quedó en sobres de 500 × $21.900 (≈ $43,8/crédito, margen ~53%): nunca bajo costo, ticket de impulso accesible, y dos packs en un mes ya casi equivalen a la diferencia con el plan superior — empuja al upgrade solo.

### Costos unitarios detrás de los precios (referencia Chile, CLP)

| Costo | Valor | Fuente |
|---|---|---|
| Mensaje utilidad/auth | $17,66 | rate card Meta en `pricing.ts` |
| Mensaje marketing | $78,49 (4,4× utilidad) | ídem |
| Mensaje servicio (respuesta del bot) | ~$19 sobre las 1.000 gratis/mes por número (desde 1-oct) | anuncio Meta; **pendiente E1–E5 implementar el medidor** |
| Conversación IA (~8–10 turnos, prompt cacheado) | gpt-4o-mini ~$5 · haiku ~$20 · **sonnet ~$65 (estándar)** · opus ~$105 | `pricing.ts` + `ai_requests` |
| Pasarela | Flow ~3,2% + IVA · Lemon Squeezy ~5% + USD 0,50 | contratos |
| Labor Conversia | Setup 4–6 h + bot Opus ~$600 · mensual: reactivo ~1 h / gestionado ~3–5 h | COGS, se mide por cliente |

### Reglas transversales

1. Precios en BD (tabla `plans`): ajustables sin deploy; "precio de lanzamiento" etiquetado; grandfathering a clientes existentes (formalizar con el pendiente «versionado de planes», `PLANS_AND_LIMITS.md` §5).
2. Packs levemente caros a propósito: el camino barato es subir de plan.
3. Nunca vender un pack bajo el costo de marketing sin ponderación (con peso 4, $29.900 queda siempre con margen ≥35%).
4. Alertas al tenant al 80% de cada cuota + aviso previo a todo débito de pack (cero sorpresas de facturación).
5. Reporte de margen por tenant en Super Admin; revisión mensual: bajo 30% de margen → renegociar o subir de plan.
6. Calibrar cuotas y supuestos con datos reales del mes 1 (`ai_requests`, `usage_events`, `WalletLedger.costUsd`); revisión trimestral de precios.

---

## 1. COSTOS VARIABLES REALES POR CLIENTE (fuentes: código de la plataforma)

### 1.1 WhatsApp (rate card oficial Meta cargado en `packages/agents/src/pricing.ts`, CLP)

| Categoría | Chile | Argentina | Colombia | México | Perú | Resto LATAM |
|---|---|---|---|---|---|---|
| Marketing | $78,49 | $54,56 | $11,04 | $26,93 | $62,07 | $65,34 |
| Utilidad / Auth | $17,66 | $22,96 | $0,71 | $7,50 | $17,66 | $9,98 |
| Servicio (respuestas del bot en ventana 24h) | **$0 hasta hoy** → desde **1-oct-2026**: 1.000 gratis/mes por número y luego ~tarifa utilidad (**~$19 CLP en Chile**) | ídem lógica por país | ~$0,7 | ~$8 | ~$18 | ~$10 |

⚠️ **Deuda técnica crítica:** `pricing.ts` todavía modela `service: 0`. Desde el 2026-10-01 eso es falso: **cada respuesta del bot sobre las 1.000 mensuales del número cuesta plata**. El medidor de mensajes de servicio (contador mensual por número) debe implementarse ANTES de vender Conversia — la **medición** es el plan E1–E5 de `PROMPTS_SERVICIO_OCT2026.md`; el **débito en bolsa para orgs Conversia es F5-B** (`PROMPT_MAESTRO_CONVERSIA.md` §4-F5). El plan E1–E5 pasa a ser prerrequisito del modelo de negocio completo, no solo de TuBot.

**El dato que cambia todo el cálculo:** el costo dominante de un bot conversacional ya no son las plantillas — son los **mensajes de servicio** (cada respuesta del bot es uno). Un cliente con 400 conversaciones/mes de 8 respuestas promedio genera 3.200 mensajes de servicio: 2.200 pagados ≈ **$41.800 CLP/mes solo en respuestas**.

### 1.2 IA por conversación (precios de `pricing.ts`, con prompt cacheado, ~8–10 turnos de bot)

| Modelo | Costo aprox. por conversación | Uso sugerido |
|---|---|---|
| gpt-4o-mini | ~$5 CLP | Tier económico / clasificación |
| claude-haiku-4-5 | ~$20 CLP | Bots simples, FAQ |
| claude-sonnet-4-6 | ~$65 CLP | **Estándar Conversia** (calidad/costo) |
| claude-opus-4-8 | ~$105 CLP | Verticales sensibles (dental) y montaje |

El modelo es configurable por agente/tenant desde el Super Admin (ya existe), y `ai_requests` registra el costo real de cada turno — la calibración del mes 1 sale de ahí, no de estas estimaciones.

### 1.3 Otros costos variables

| Ítem | Valor | Nota |
|---|---|---|
| Pasarela Flow (CLP) | ~3,2% + IVA por cobro | verificar % exacto del contrato |
| Lemon Squeezy (USD, LATAM) | ~5% + USD 0,50 | ya cableado, falta estrenarlo; pendiente W-3 (paquetes USD) |
| Infra marginal (Railway) | ~$2.000–5.000 CLP/tenant | estimación al volumen actual |
| **Labor Conversia** (la diferencia vs TuBot) | Implementación: bot Opus ~$600 CLP + 4–6 h humanas. Mensual: tier reactivo ~1 h; tier gestionado ~3–5 h | **es COGS, no gasto de venta** — se mide por cliente |

---

## 2. ESCENARIOS DE CONSUMO POR VERTICAL (supuestos explícitos — calibrar con datos reales el mes 1)

| Escenario | Conversaciones/mes | Msgs servicio (8 resp/conv; pagados sobre 1.000) | Utilidad (2/cita) | Marketing | IA (modelo) | **COGS variable total** |
|---|---|---|---|---|---|---|
| **Servicios chico** (técnico, gásfiter) | 150 | 1.200 → 200 × $19 = $3.800 | 240 × $17,66 = $4.238 | 0 | $9.750 (sonnet) | **~$18.000** |
| **Barbería** (2–4 sillones) | 250 | 2.000 → 1.000 × $19 = $19.000 | 700 × $17,66 = $12.362 | 0 (difusiones aparte) | $16.250 (sonnet) | **~$48.000** |
| **Barbería + difusión mensual** (400 contactos mkt) | 250 | $19.000 | $12.362 | 400 × $78,49 = $31.396 | $16.250 | **~$79.000** |
| **Clínica dental mediana** (600 citas) | 400 | 3.200 → 2.200 × $19 = $41.800 | 1.200 × $17,66 = $21.192 | 200 × $78,49 = $15.698 | $42.000 (opus) | **~$121.000** |

(+ Flow ~3,2%+IVA sobre la mensualidad + infra ~$3.000 en todos los casos.)

**Lecturas:**
1. La dispersión es enorme ($18k–$121k): **un precio único sin cuotas es inviable** — confirma tu instinto de cuotas + excedente.
2. El marketing cuesta 4,4× la utilidad en Chile: las difusiones JAMÁS van "incluidas ilimitadas"; se ponderan o se venden aparte.
3. En Colombia/México los mismos escenarios cuestan una fracción (utilidad $0,7–7,5): LATAM mejora el margen, no lo empeora — pero Argentina es más cara en utilidad que Chile ($22,96).

---

## 3. DISEÑO DE CUOTAS (reutiliza lo que ya existe — cero mecánica nueva)

La plataforma ya tiene las tres piezas; solo hay que configurarlas y completar el medidor de servicio:

1. **Bolsa de créditos prepagada** (`MessageWallet` + `WalletLedger`): débito atómico antes de cada envío, **pesos por categoría configurables desde el Super Admin sin redeploy**. Configuración recomendada: **utilidad 1 · servicio 1 · autenticación 1 · marketing 4** (≈ ratio de costo real en Chile — protege el margen pase lo que pase con la mezcla). Al cliente se le muestra "créditos" + estimación amable ("≈ 1.500 recordatorios").
2. **IA sin cupo comercial (simplificación 2026-09-30)**: los créditos de mensajes regulan solos la actividad del bot (cada respuesta descuenta). No hay medidor comercial de conversaciones ni cobro por IA. El tope diario de tokens (`aiTokensDaily`, Super Admin) queda como fusible interno anti-abuso, invisible al cliente.
3. **Excedentes como packs "levemente caros"** (filosofía ya documentada en `PREPAID_WALLET_DESIGN.md`): el camino barato debe ser subir de plan, no vivir comprando packs.

**Packs de excedente propuestos (Chile):**

| Pack | Precio | Costo peor caso | Margen |
|---|---|---|---|
| Sobre de 500 créditos de mensajes (con ponderación 1/1/1/4) — ajustado 2026-09-30 | $21.900 | ~$9.800 | **~53%** garantizado por la ponderación |

Alternativas evaluadas y descartadas (2026-09-30): 1.000 créditos a $59.900 ("el doble") — ticket de impulso más duro; y pack de 100 conversaciones IA a $14.900 — eliminado: el único excedente cobrable es el de créditos de mensajes; el cupo de conversaciones IA es límite de plan con alerta al 80% y upgrade como camino.

---

## 4. PLANES CONVERSIA PROPUESTOS (entrada agresiva + setup obligatorio)

**Setup de implementación (obligatorio, pagadero una vez, por local/sede):**
- Precio de lanzamiento: **$190.000 + IVA** (regular $290.000; dental con integración Cláriva/Dentalink: $290.000 lanzamiento / $390.000 regular).
- Cubre el costo real: 4–6 h humanas + bot de implementación + alta de WhatsApp/Meta. Si el cliente se va al mes 2, el setup ya pagó la implantación — el churn temprano no destruye la economía.

**Mensualidades (dos tiers, por vertical):**

| | **Funcionando** | **Gestionado** | **Custom** |
|---|---|---|---|
| Precio lanzamiento (Chile) | **$149.900 + IVA/mes** | **$299.900 + IVA/mes** | A cotización (ref. desde ~$499.900) |
| IA conversacional | Sin tope comercial (se regula por créditos) | Sin tope comercial | Sin tope comercial |
| Créditos de mensajes incluidos | 1.500 | 4.000 | A medida (regla: costo de créditos ≤ 35% del precio) |
| Servicio | Mantención reactiva: hasta 3 solicitudes de cambio/mes, SLA 48h | + revisión proactiva mensual de conversaciones, ajuste de prompts, reporte de resultados, 1 difusión gestionada/mes (hasta 500 contactos, créditos aparte) | A medida: multi-sede, integraciones, difusiones mayores, SLA preferente |
| Excedentes | sobres §3 | sobres §3 | según contrato |
| Permanencia | 6 meses (o setup regular sin permanencia) | 6 meses | contrato propio (12 meses sugerido) |

**Chequeo de margen (escenarios §2, incluyendo Flow + infra):**

| Plan × escenario | Ingreso | COGS variable | Labor | **Margen bruto** |
|---|---|---|---|---|
| Funcionando × servicios chico | $149.900 | ~$26.000 | ~$15.000 (1h) | **~$109.000 (73%)** |
| Funcionando × barbería | $149.900 | ~$56.000 | ~$15.000 | **~$79.000 (53%)** |
| Gestionado × barbería+difusión | $299.900 | ~$92.000 | ~$60.000 (4h) | **~$148.000 (49%)** |
| Gestionado × dental mediana | $299.900 | ~$135.000 | ~$75.000 (5h) | **~$90.000 (30%)** |

Todos los cruces quedan sobre agua; el peor caso (dental intensivo en Gestionado) da ~30% — aceptable para el tier de servicio, y mejorable porque sus excedentes (créditos/conversaciones sobre cuota) se cobran con margen. Si un dental consume sistemáticamente más, su cuota lo empuja al excedente o a un plan superior por sedes — el sistema se defiende solo.

**Regla de ajuste futuro (tu requisito):** los precios viven en la tabla `plans` (BD) — se cambian sin deploy. Política: "precio de lanzamiento" etiquetado como tal; los clientes existentes conservan su precio (grandfathering); los nuevos entran al vigente. El pendiente «versionado de planes» (`PLANS_AND_LIMITS.md` §5) formaliza esto y **sube de prioridad**.

---

## 5. TUBOT: SIN CAMBIOS (decisión 2026-09-30)

Los planes de TuBot quedan como están — ya están OK y en producción; este documento se enfoca solo en Conversia. Queda archivada la propuesta de descontar servicio de la bolsa TuBot; acción única: cuando el medidor E1–E5 esté activo, monitorear el costo de servicio real por tenant TuBot en el reporte de margen (§7.4) y revisar solo si algún tenant rompe el margen.

## 6. LATAM (decisión: desde el inicio)

- Cobro en USD vía Lemon Squeezy (cableado; estrenar) + completar W-3 (packs en USD). Referencia: Funcionando ~USD 159 / Gestionado ~USD 319 / setup ~USD 199–299.
- El rate card por país ya está en `pricing.ts` y la bolsa registra `costUsd` real por envío: **misma cuota de créditos en todos los países**, y el reporte de margen por tenant (§7) detecta si algún país rompe el modelo (Argentina es el único con utilidad más cara que Chile; Colombia/México regalan margen).
- Servicio llave en mano remoto: la implementación ya es 100% por WhatsApp/panel (el bot de montaje no tiene geografía).

## 7. GUARDRAILS "PARA NO TENER PROBLEMAS DESPUÉS"

1. **Medidor de mensajes de servicio** (E1–E5) — prerrequisito absoluto; sin esto el COGS es invisible.
2. **W-2**: devolver el crédito si el envío falla (hoy se pierde) — con volumen deja de ser anécdota.
3. **Contador de mensajes/créditos visible y confiable en la cuenta** (requisito de Javier): saldo actual, consumo del mes por categoría y proyección de agotamiento, en el panel del cliente Conversia y en el Super Admin. Los datos ya existen (`MessageWallet`/`WalletLedger`); falta el widget. + **Alertas al 80%** de los créditos y aviso ANTES del débito de cada sobre — antídoto anti-sorpresas.
4. **Reporte de margen por tenant en Super Admin**: ingreso del plan − (WalletLedger.costUsd + ai_requests.costUsd + horas registradas de servicio). Los datos ya existen; falta la vista. Revisión mensual: cualquier tenant bajo 30% de margen se renegocia o se sube de plan.
5. **Fusible global** (existe) + tope duro configurable por tenant para difusiones.
6. **Calibración**: mes 1 con clientes reales → reemplazar los supuestos de §2 por percentiles reales de consumo por vertical; revisar precios/cuotas trimestralmente (los precios en BD lo permiten sin fricción).
