# Modelo de cobro de Conversia: de "conversaciones" a "Créditos IA"

**Fecha:** 27-oct-2026 · **Estado:** precios y unidad DECIDIDOS por el dueño (§8).
**Etapa 1 (motor de créditos) construida** — PR #557, 28-oct-2026; resultados en
`docs/CREDITOS_IA_RESULTADOS.md`. Pendientes las Etapas 2 (catálogo y migración),
3 (transparencia y avisos) y 4 (margen), en el orden de `PLAN_EJECUCION_LANZAMIENTO.md`.

> El motor está APAGADO para todos: cobra solo si el plan tiene
> `features.aiCreditsWallet`, y ningún plan del catálogo lo trae todavía. Se enciende con
> la Etapa 2, cuando el dueño apruebe activar el catálogo nuevo.

## Decisión que origina este documento

El dueño decidió que **cada cliente paga a Meta con su propia tarjeta** (sin línea de
crédito compartida; ver el análisis de Solution Partner del 27-oct). Conversia cobra solo
por **el uso de la plataforma y de la IA**. El copiloto de montaje guía al cliente para
cargar su tarjeta en Meta (`docs/PROMPT_COPILOTO_MONTAJE.md`, Etapa 3).

Esto cambia la base del modelo V2: los precios por conversación (`CONVERSIA_V2.md` §2.1,
~$200 CLP/conversación) se calcularon para **absorber el costo de Meta**, que era ~$152 de
esos $200. Sin Meta, nuestro costo variable es casi solo la IA y la unidad
"conversación" deja de calzar con el costo real.

---

## PARTE A — Análisis

### 1. Cómo cobra hoy la plataforma

- **Unidad:** 1 crédito = 1 conversación atendida por el bot en la ventana de 24 h
  (`apps/worker/src/conversation-credits.ts`). Se debita al **contar** la conversación por
  primera vez, sin importar si después el bot responde 2 o 40 veces.
- **Planes y packs** (`packages/database/scripts/seed-conversia-catalog.mjs`): Base
  $18.900/mes con 100 conversaciones; packs de 400 ($84.900), 1.000 ($199.900) y recarga de
  100 ($21.900). Prueba: 30 conversaciones gratis.
- **Ya construido y reutilizable:** lotes con vencimiento (plan 2 meses, comprados 12),
  libro contable auditado, gracia de 20 para que el bot nunca quede mudo, avisos al 75% y
  90%, auto-recarga con tope mensual obligatorio (`billing.controller.ts:869`), y el
  multiplicador x2 del "Asistente Plus".
- **Ojo:** los planes Conversia antiguos tienen `serviceDebitsWallet` (Conversia cobrando
  los mensajes de servicio de Meta). Con la tarjeta del cliente en Meta, eso queda apagado
  para todos los planes nuevos.

### 2. El problema que viste es real

Lo que cuesta de verdad es **cada respuesta del bot** (cada llamada a la IA), no la
conversación. Una conversación puede tener 2 respuestas ("¿atienden el sábado?") o 30 (un
paciente que agenda, reagenda y pregunta precios). Con la unidad "conversación":

- Nuestro costo por conversación varía **10x o más** entre una corta y una larga.
- Varía otra vez **hasta ~20x** según el modelo de IA del agente (costos de
  `CONVERSIA_COSTOS.md` §1.2, ~8–10 respuestas por conversación):

  | Modelo | Costo por conversación | Costo por respuesta (aprox.) |
  |---|---|---|
  | gpt-4o-mini | ~$5 CLP | ~$0,6 |
  | claude-haiku-4-5 | ~$20 CLP | ~$2,2 |
  | claude-sonnet-4-6 | ~$65 CLP | ~$7 |
  | claude-opus-4-8 | ~$105 CLP | ~$11,5 |

- Un cliente con conversaciones largas, un modelo caro o una base de conocimiento grande
  puede costarnos mucho más de lo que paga, y no lo vemos hasta fin de mes.

### 3. Las tres opciones

| | Por conversación (hoy) | Por mensaje/respuesta | Por tokens puros |
|---|---|---|---|
| Lo entiende el cliente | Muy bien ("clientes atendidos") | Bien ("respuestas de mi bot") | Mal ("¿qué es un token?") |
| Calza con nuestro costo | Mal (varía 10–20x) | Bien (cada respuesta es una llamada a la IA) | Exacto |
| Ansiedad del cliente | Baja | Media | Alta: no sabe cuánto le dura |
| Predecir cuánto le alcanza | Fácil | Fácil con un estimador | Difícil sin traducirlo |

**Referencia de mercado:** Respond.io cobra la plataforma por contactos activos y la IA con
**créditos por respuesta** (2 a 5 créditos según el tipo de respuesta, con créditos extra
pagados aparte), y pasa el costo de Meta sin recargo, cobrado por separado. Es justo lo que
planteas.

### 4. Recomendación: "Créditos IA" cobrados por respuesta y ajustados por tokens

Un solo concepto para el cliente, **Créditos IA**, que por dentro se calcula con los tokens
reales:

- **1 respuesta normal del bot = 1 crédito** (modelo estándar).
- **Las respuestas muy largas consumen más:** por cada bloque de tokens sobre el límite de
  una respuesta normal se suma 1 crédito. Fórmula:
  `créditos = peso_del_modelo × máx(1, techo(tokens_de_la_respuesta / TOKENS_POR_CRÉDITO))`.
  `tokens_de_la_respuesta` incluye todas las llamadas a la IA del turno (herramientas,
  clasificación). **Valor calibrado (27-oct, §7): `TOKENS_POR_CRÉDITO = 20.000`.** El 90%
  de las llamadas reales a gpt-4o-mini usa menos de ~16.000 tokens, así que casi toda
  respuesta cuesta 1 crédito y solo las muy cargadas (historial largo, varias herramientas)
  suman más.
- **Peso por modelo**, calibrado con el costo real por llamada (§7) para que un crédito nos
  cueste como máximo ~$2 CLP con cualquier modelo:

  | Nivel de IA | Modelos | Costo real por respuesta | Créditos por respuesta |
  |---|---|---|---|
  | Estándar | gpt-4o-mini | ~$1,9 CLP | 1 |
  | Plus | claude-haiku | ~$7,8 CLP | 4 |
  | Avanzado | gpt-4o | ~$24 CLP | 12 |
  | Avanzado | claude-sonnet | ~$42 CLP (estimado) | 20 |
  | Premium | claude-opus | ~$100 CLP | 50 — **no disponible en autoservicio**, solo planes gestionados |

- **Quién elige el modelo (decisión del dueño, 27-oct):**
  - Todo bot de cliente nace con **gpt-4o-mini**.
  - Un modelo más avanzado se activa **solo desde el super admin de Conversia**, por agente,
    cuando un cliente lo necesita. El cliente **no puede cambiarlo** desde su panel, ni
    pedírselo al copiloto.
  - Antes de activarlo, el cliente queda **avisado y conforme**: se le muestra cuántos
    créditos por respuesta consume el modelo nuevo y cuánto le duraría su saldo a su ritmo
    actual ("con el modelo Plus, tus 1.000 créditos rinden ~60 conversaciones en vez de
    ~240"). Su aceptación queda registrada con fecha y usuario, y un cambio de vuelta a
    gpt-4o-mini no requiere aceptación.
- **El contador mide el consumo real de cada cliente:** cada débito se calcula con los
  tokens reales de la respuesta y el modelo que efectivamente la generó (no con un
  promedio), y queda guardado en el libro con créditos, tokens, modelo y costo USD. Así el
  medidor del cliente y el reporte de margen del super admin muestran lo que realmente gastó
  cada uno.
- **Lo que NO consume créditos:** el copiloto de montaje y el asistente del panel (son
  nuestro costo de venta y soporte, acotados por el límite de uso que ya existe),
  las respuestas que escribe una persona desde la Bandeja, los mensajes entrantes que no
  llevan respuesta de IA y los recordatorios o plantillas (esos los cobra Meta al cliente).

**Por qué este modelo:**
- Calza con nuestro costo: el peor caso por crédito queda acotado, sin importar el modelo
  ni el largo de la conversación.
- El cliente entiende "respuestas de mi bot", y además le mostramos **cuántas
  conversaciones le alcanzan**, calculado con **su propio promedio** de los últimos 30 días
  (o el promedio del rubro si es nuevo): "Te quedan 1.240 créditos ≈ 140 conversaciones ≈
  18 días a tu ritmo".
- Reutiliza todo lo construido (lotes, libro, gracia, avisos, auto-recarga). Cambia **dónde
  y cuánto** se debita, no el sistema.

### 5. Precios (calibrados con los datos reales del §7; metas de margen del dueño, 27-oct)

**Regla del dueño (27-oct, corregida):** **ganancia mínima de 300% sobre el costo** en todo
pack, que es lo mismo que un **margen mínimo de 75% sobre el precio neto**. Precios **con
IVA incluido**. Siempre editables desde el catálogo, nunca en el código.

> **"Margen" y "ganancia" NO son lo mismo — conviene no confundirlos:**
> - **Margen sobre el precio** = `ganancia / precio neto`. Responde *"de cada $100 que
>   entran, ¿cuánto me queda?"*. Nunca puede pasar de 100%.
> - **Ganancia sobre el costo** = `ganancia / costo`. Responde *"¿cuántas veces recupero lo
>   que gasté?"*. No tiene techo.
>
> Son dos formas de decir lo mismo: si de $100 netos el costo es $25 y la ganancia $75, el
> **margen es 75%** y la **ganancia es 300%** (75 es 3 veces 25). Por eso la regla "300% de
> ganancia mínima" equivale a "75% de margen mínimo".
>
> El **costo** acá incluye las tres cosas: los créditos consumidos ($2,1 c/u), la comisión
> de Flow (3,81% del precio cobrado) y, solo en el plan Base, el costo fijo por cliente.
> El **plan Base es la única excepción** a la regla de 300% (ver más abajo).

**Supuestos del cálculo (conservadores):**
- Costo por crédito: **$2,1 CLP**. Es el costo real promedio de una llamada a gpt-4o-mini
  (USD 0,00204), con el dólar a $1.000 (el repo usa 950 de referencia) y 3% de colchón por
  herramientas y respuestas largas.
- Comisión Flow: 3,2% + IVA = **3,81%** del precio cobrado.
- Costo fijo por cliente en el plan Base: infraestructura ~$3.000 + uso del copiloto y el
  asistente del panel ~$500.
- Margen a **consumo pleno**: el cliente gasta todos sus créditos. Si no los gasta, el
  margen real es mayor.
- Una conversación real usa en promedio **~4,2 créditos** (mediana 3, el 90% usa 9 o menos).

Precio mínimo por crédito para cada meta, con precios **+ IVA**: 80% → $12,97 · 75% →
$9,91 · 70% → $8,02.

#### Opción A — precios + IVA (descartada; se deja como referencia)

| Producto | Créditos | Precio + IVA | CLP por crédito | Margen | Alcanza para aprox. |
|---|---|---|---|---|---|
| Prueba gratis | 200 | $0 | — | costo de adquisición ~$420 | ~48 conversaciones |
| **Plan Base mensual** | **500** | **$18.990/mes** | — | **72,2%** | ~120 conversaciones |
| Pack chico | 300 | $3.990 | 13,30 | 80,4% | ~70 conversaciones |
| Pack chico | 1.000 | $12.990 | 12,99 | 80,0% | ~240 conversaciones |
| Pack chico | 2.500 | $32.490 | 13,00 | 80,0% | ~600 conversaciones |
| Pack mediano | 5.000 | $49.990 | 10,00 | 75,2% | ~1.200 conversaciones |
| Pack grande | 13.000 | $104.990 | 8,08 | 70,2% | ~3.100 conversaciones |
| Pack grande | 24.000 | $199.990 | 8,33 | 71,0% | ~5.700 conversaciones |

Créditos del plan Base y su margen (+ IVA): 200 → 75,5% · 300 → 74,4% · 400 → 73,3% ·
**500 → 72,2%** · 600 → 71,1% · 700 → 70,0% (el máximo que respeta el 70%). Se recomienda
**500**: deja ~2 puntos de colchón y equivale a ~120 conversaciones, más que las 100 que
incluía el modelo anterior.

#### Opción B — precios con IVA incluido (lo que paga el cliente final) — ✅ ELEGIDA por el dueño (27-oct)

Los $18.990 ya incluyen IVA, así que el ingreso **neto** es $15.958 (`precio / 1,19`).
Costos: **$2,1 por crédito** + **3,81% de Flow** sobre el precio cobrado.

| Producto | Créditos | Precio IVA incl. | CLP por crédito | **Ganancia sobre costo** | Margen sobre neto | Alcanza para aprox. |
|---|---|---|---|---|---|---|
| Prueba gratis | 200 | $0 | — | — (costo de adquisición ~$420) | — | ~48 conversaciones |
| **Plan Base mensual** | **100** | **$18.990/mes** | — | **260%** ⚠ excepción | 72,2% | ~24 conversaciones |
| **Recarga básica** (la más barata; la de la recarga automática) | **1.000** | **$18.990** | 18,99 | **465%** | 82,3% | ~240 conversaciones |
| Pack | 3.000 | $49.990 | 16,66 | **412%** | 80,5% | ~710 conversaciones |
| Pack | 6.000 | $89.990 | 15,00 | **372%** | 78,8% | ~1.430 conversaciones |
| Pack | 8.500 | $109.990 | 12,94 | **319%** | 76,2% | ~2.020 conversaciones |
| Pack | 16.000 | $199.990 | 12,50 | **308%** | 75,5% | ~3.810 conversaciones |

Todos los packs cumplen la regla: **≥ 300% de ganancia sobre el costo** (≥ 75% de margen).
El más grande es el que queda más al límite (308%), así que es el primero a revisar si sube
el costo del dólar o de los modelos.

**Por qué el plan Base es la excepción (260%).** Además de los créditos y la comisión, el
plan carga el **costo fijo por cliente** (~$3.500: infraestructura, copiloto y asistente del
panel). Con 100 créditos incluidos, el costo total queda en ~$4.434 contra $15.958 netos →
260%. Subir el precio o bajar más los créditos haría el plan poco atractivo: **la ganancia
del negocio viene de las recargas**, no del plan. El plan es la puerta de entrada.

**La recarga básica vale lo mismo que el plan ($18.990) pero trae 1.000 créditos** (465%),
diez veces más que el plan, justamente porque el plan además paga la plataforma. Es el pack
que se cobra solo con la **recarga automática** (§6) cuando el saldo se está agotando.

> **Packs eliminados** (versión anterior del documento): 1.150, 2.500, 5.000, 11.000 y
> 20.000. No cumplían la regla de 300%.

**Sensibilidad:** si el costo por crédito sube 10% (dólar más caro o prompts más largos),
cada margen baja ~2 puntos. Por eso el reporte mensual de la Etapa 4 recalibra los precios.

- Contra Respond.io, que según fuentes de terceros cobra unos USD 15 por cada 1.000 créditos
  extra (con 2 a 5 créditos por respuesta), nuestro precio por respuesta queda bastante más
  bajo. Hay espacio para subir si los datos lo justifican.

**Lo que el cliente paga a Meta aparte**, con su tarjeta: plantillas (recordatorios,
difusiones) y mensajes de servicio sobre el tramo gratis mensual que documenta
`CONVERSIA_COSTOS.md` (1.000 por número al mes; confirmar con la tarifa vigente de Meta).
Lo mostramos en el panel como **estimación informativa**, con la aclaración de que lo cobra
Meta directo.

### 6. Avisos, recarga automática y el "¿cuánto me alcanza?"

- **Avisos** al 75%, al 90% y al llegar a 0, por **correo, WhatsApp, notificación push y
  banner en el panel**, una vez por umbral y período. Cada aviso dice cuánto queda en
  créditos, en conversaciones estimadas y en días a su ritmo, con botón directo para
  recargar.
- **Recarga automática con tarjeta de crédito** (decisión del dueño, 27-oct; ya existe en
  el código y se adapta a créditos):
  - Cuando el saldo baja de **50 créditos** (~12 conversaciones), se cobra sola la
    **recarga básica de $18.990 (1.000 créditos)** a la tarjeta guardada con Flow. Se
    dispara antes de llegar a 0 para que el bot no se corte mientras se procesa el pago.
  - Se ofrece **activada por defecto** al registrar la tarjeta, con una casilla de
    consentimiento explícito ("Recargar automáticamente $18.990 cuando mis créditos se
    estén agotando"), y se puede apagar en cualquier momento desde Cobros.
  - **Tope mensual obligatorio**, como hoy: por defecto 3 recargas automáticas al mes
    ($56.970), editable por el cliente. Al llegar al tope se avisa y no se cobra más.
  - Cada recarga automática envía un correo y una notificación con el monto, los créditos
    sumados y el comprobante. Si el cobro falla (tarjeta rechazada), se avisa de inmediato
    y entra la gracia.
  - Requiere la tarjeta guardada con Flow, que entrega la Etapa 0 del copiloto.
- **Gracia:** 100 créditos (≈ 25 conversaciones, parecido a las 20 de hoy). El bot **nunca queda mudo de
  golpe**: al agotar la gracia responde con la frase de respaldo y deriva a una persona,
  como hoy.
- **Estimador visible** en Inicio, Cobros y en el copiloto: medidor de créditos más
  "≈ N conversaciones · ~D días".

### 7. Costos reales de producción (`ai_requests`, 25-jul al 26-oct-2026)

Medido por el dueño el 27-oct con el script de solo lectura
`packages/database/scripts/_tmp_ai_cost_stats.cjs` (agregados, sin datos de clientes).
Tipo de cambio de referencia: 950 CLP/USD.

| Modelo | Llamadas | Conversaciones | Costo por llamada | Costo por conversación (mediana / prom. / máx.) |
|---|---|---|---|---|
| gpt-4o-mini | 6.196 | 1.530 | ~$1,9 | $3,9 / $7,8 / $245 |
| gpt-4o | 147 | 58 | ~$24 | $45 / $61 / $206 |
| claude-haiku-4-5 | 77 | 4 | ~$7,8 | $93 / $150 / $376 |
| claude-opus-4-8 | 147 | 7 | ~$100 | $64 / $2.100 / **$12.478** |

Lo que muestran los datos:
- **Una sola conversación con Opus costó USD 13 (~$12.500 CLP)**: 110 llamadas y 2,4
  millones de tokens. Con el cobro por conversación habría consumido 1 crédito (~$200).
  Es exactamente el riesgo que motivó este cambio. Por eso Opus queda fuera del
  autoservicio.
- Incluso con gpt-4o-mini, la conversación más cara costó **60 veces** la mediana.
- **Casi todo el costo es entrada (input):** ~9.600 tokens por llamada en la mediana contra
  ~60 de salida. Es el prompt del agente, su conocimiento y el historial, que se reenvían en
  cada respuesta. Optimizarlo (prompt más corto, caché de prompt, historial acotado) baja el
  costo directo; `pricing.ts` hoy calcula el input completo sin descuento de caché, así que
  el costo real probablemente es algo menor.
- Una conversación tiene en la mediana **2 mensajes del cliente y 3 respuestas**; el 90%
  tiene 10 respuestas o menos.
- **Desde el 14-oct hay bots usando gpt-4o** (58 conversaciones), que cuesta ~12 veces más
  que gpt-4o-mini. Revisar qué agentes lo tienen configurado y si es intencional.

### 8. Decisiones del dueño

1. **Unidad:** ¿aprobado "Créditos IA" con 1 respuesta estándar = 1 crédito?
2. ~~Precios~~ **Decidido (27-oct, corregido): opción B del §5, precios con IVA incluido y
   regla de ganancia mínima de 300% sobre el costo** (= 75% de margen sobre el neto):
   - Plan Base **$18.990/mes con 100 créditos** (260%: única excepción, por el costo fijo
     por cliente; la ganancia del negocio viene de las recargas).
   - Recarga básica **1.000 créditos a $18.990** (465%) — la más barata y la que usa la
     recarga automática.
   - Packs: **3.000/$49.990** (412%) · **6.000/$89.990** (372%) · **8.500/$109.990** (319%)
     · **16.000/$199.990** (308%).
   - Prueba gratis **200** créditos; gracia **100**.
   - Se **eliminan** los packs anteriores de 1.150, 2.500, 5.000, 11.000 y 20.000.
3. ~~Modelo estándar~~ **Decidido (27-oct):** gpt-4o-mini por defecto; modelos más
   avanzados solo los activa el equipo de Conversia desde el super admin, con el cliente
   avisado y conforme (§4).
4. **Clientes actuales:** se convierten a 10 créditos por cada conversación que les quede
   (las 30 de prueba pasan a 300). Como una conversación usa ~4 créditos, ganan saldo y
   nadie pierde.

---

## PARTE B — PROMPT DE DESARROLLO (enviar al desarrollador)

**Para el desarrollador (Claude Code en VS Code, con agentes).** El dueño decidió que cada
cliente paga a Meta con su tarjeta, y que Conversia cobra plataforma + IA con una nueva
unidad, **Créditos IA**. Lee primero la Parte A de este documento: ahí está el análisis, la
fórmula y los precios propuestos. Todo valor (pesos, `TOKENS_POR_CRÉDITO`, precios, gracia,
umbrales) va en catálogo o `platform_settings`, **nunca en el código**.
**TuBot está en producción y no se toca:** todo esto aplica solo a la marca `conversia`
detrás de un feature del plan (p. ej. `features.aiCreditsWallet`).

### Etapa 1 — Motor de Créditos IA
- Débito por **respuesta del bot** (turno del agente) en el worker: suma los tokens de
  todas las llamadas del turno (`ai_requests` del turno), aplica la fórmula
  `peso_modelo × máx(1, techo(tokens / TOKENS_POR_CRÉDITO))` y debita esos créditos.
  Idempotente por turno (`runId`/id del turno). Antes de generar la respuesta, verifica
  que haya saldo o gracia; el débito real se hace con los tokens reales al terminar.
- Reutiliza lotes, libro contable, vencimientos, gracia y FIFO de
  `conversation-credits.ts`, generalizando la unidad (sin duplicar el sistema). En el libro
  contable registra por débito: créditos, tokens, modelo, costo USD real y conversación.
- Pesos por nivel de modelo configurables con los valores calibrados de la Parte A §4
  (gpt-4o-mini 1 / claude-haiku 4 / gpt-4o 12 / claude-sonnet 20 / claude-opus 50) y mapeo modelo → nivel. Si un modelo no
  tiene nivel, se cobra como premium y se levanta una alerta al super admin. El nivel premium
  (Opus) no se puede elegir en planes de autoservicio.
- Revisar qué agentes en producción usan gpt-4o desde el 14-oct (Parte A §7) y reportarlo
  en el PR, sin cambiarlos: el dueño decide.
- **Selección de modelo solo por la plataforma** (Parte A §4, "Quién elige el modelo"),
  para orgs `conversia`:
  - Los agentes nuevos (vertical, `/crear`, copiloto, `POST /agents`) nacen con
    gpt-4o-mini, leído de configuración, no del código.
  - Los endpoints de tenant que editan agentes (`PUT /agents/:id/draft` y similares)
    **rechazan o ignoran** cambios de `config.model`; el copiloto no tiene herramienta para
    cambiar el modelo. Test que lo verifique.
  - En la consola del super admin: selector de modelo por agente que muestra el peso en
    créditos y, antes de aplicar uno más caro, genera un **aviso al cliente** (in-app y
    correo) con el impacto estimado en su saldo y un botón "Acepto". El cambio se aplica al
    aceptar (o el super admin lo fuerza dejando constancia del motivo). Todo auditado:
    quién lo pidió, quién aceptó y cuándo.
- **Consumo real por cliente:** el débito usa el modelo que efectivamente respondió (si el
  router cambió de modelo por falta de proveedor, se cobra el que respondió). El libro
  guarda créditos, tokens de entrada y salida, modelo y costo USD por respuesta, y el
  medidor del cliente indica el nivel de IA de cada agente.
- No debitan créditos: el copiloto y el asistente del panel, las respuestas humanas, los
  mensajes sin respuesta de IA, las plantillas y recordatorios.
- `serviceDebitsWallet` apagado en los planes nuevos de Conversia (Meta le cobra directo
  al cliente). El cobro de servicio de TuBot no cambia.
- Tests: fórmula (bordes del bloque de tokens, pesos), idempotencia, gracia, vencimiento,
  saldo concurrente (dos turnos a la vez), y que TuBot no cambie.

### Etapa 2 — Catálogo, migración y cobro
- Catálogo nuevo con los precios de la **opción B** de la Parte A §5 (IVA incluido, regla de
  ganancia mínima de 300% sobre el costo): plan **Base $18.990/mes con 100 créditos**,
  **recarga básica 1.000 créditos a $18.990**, packs **3.000 / 6.000 / 8.500 / 16.000**
  ($49.990 / $89.990 / $109.990 / $199.990), prueba de **200** créditos y gracia de **100**.
  Los packs viejos (1.150, 2.500, 5.000, 11.000, 20.000) **no se siembran**. Todo sembrado
  **INACTIVO** con el script idempotente de catálogo; se activa con el OK del dueño.
- **IVA incluido:** hoy el cobro no suma IVA (Flow cobra el `priceClp` tal cual), lo que
  calza con esta decisión; **no agregar un 19% encima**. Los textos de precios (landing,
  `/cobros`, copiloto, correos) dicen "IVA incluido", y cualquier comprobante o reporte que
  desglose montos usa neto = precio / 1,19. Actualizar los precios de respaldo escritos en
  el frontend (p. ej. el `"$18.900"` de `inicio/page.tsx` y de la landing) para que lean
  del catálogo o, si queda un respaldo, digan $18.990. Los planes y packs de
  conversaciones se desactivan para ventas nuevas, sin borrarlos.
- Migración de saldos: conversaciones restantes × 10 = créditos, con su vencimiento
  original, en un script con **dry-run por defecto** que imprime el antes y el después por
  organización. Asiento auditado por cada conversión. Nadie pierde saldo.
- **Recarga automática con tarjeta** según la Parte A §6: umbral de 50 créditos, cobra la
  recarga básica de $18.990 (1.000 créditos) a la tarjeta guardada con Flow, ofrecida
  activada al registrar la tarjeta con consentimiento explícito y registrado, tope mensual
  obligatorio (por defecto 3 recargas), correo y notificación por cada cobro, y aviso
  inmediato más gracia si la tarjeta es rechazada. Idempotente: un solo cobro por umbral
  aunque lleguen varias respuestas a la vez. Umbral, pack y tope por defecto en
  configuración, no en el código.
- Herramientas del asistente/copiloto (`ofrecerRecarga`, `verEstado`) y textos del panel
  hablan de Créditos IA, siempre leyendo precios del catálogo.

### Etapa 3 — Transparencia y avisos
- **Estimador:** promedio de créditos por conversación de la org en los últimos 30 días
  (mínimo 20 conversaciones; si no, promedio del rubro). Endpoint que devuelve créditos
  restantes, conversaciones estimadas y días estimados a su ritmo.
- **Medidor** en Inicio, Cobros y el copiloto: "1.240 créditos ≈ 140 conversaciones ≈ 18
  días". Historial: créditos por conversación (cuáles gastaron más y por qué: largo o
  modelo).
- **Avisos** al 75%, 90% y 0 por correo, WhatsApp, push y banner, una vez por umbral y
  período, con el estimado y un botón de recarga. Plantillas de correo con la marca
  Conversia.
- **Costos de Meta (informativo):** tarjeta en Cobros con la estimación del mes según
  `usage_events` (plantillas y servicio), explicando que Meta lo cobra directo a la tarjeta
  del cliente.
- Landing y `/crear`: la sección de precios muestra Créditos IA con la equivalencia
  aproximada en conversaciones.

### Etapa 4 — Margen y calibración
- Reporte en el super admin: por organización y mes, ingresos contra costo real de IA
  (`ai_requests.costUsd`) e infraestructura estimada, con el margen. Alerta si una org baja
  de 40% de margen.
- Al cerrar cada mes, recomendación de calibración: créditos promedio por conversación,
  tokens promedio por respuesta y si `TOKENS_POR_CRÉDITO` o los pesos deben ajustarse.

### Cierre
- typecheck, tests, sim250 y Playwright en verde. Playwright "dueño nuevo": prueba con 200
  créditos → conversaciones → aviso al 75% → recarga → saldo actualizado. Un PR por etapa.
- Después de cada etapa, verificar que conversia-web quedó publicada con el sello de versión
  igual a `main` (autodeploy de #538).
- El orden de estas etapas, intercaladas con la auditoría y el copiloto, lo fija
  `docs/PLAN_EJECUCION_LANZAMIENTO.md`. El script `_tmp_ai_cost_stats.cjs` lo corre el
  dueño; el desarrollador no toca producción.
- Entregable `docs/CREDITOS_IA_RESULTADOS.md`: qué quedó, valores sembrados, resultado del
  dry-run de migración y decisiones tomadas.

### Reglas duras
TuBot intacto · ningún precio, peso ni umbral en el código · migración solo con dry-run
primero y OK del dueño para aplicar en producción · el bot jamás queda mudo por saldo · nada
de credenciales en texto plano · prohibido marcar verde lo que no se vio funcionar.
