# Modelo de cobro de Conversia: de "conversaciones" a "Créditos IA"

**Fecha:** 27-oct-2026 · **Estado:** propuesta para decisión del dueño, con prompt de
desarrollo al final (Parte B).

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
  clasificación). Valor inicial propuesto: `TOKENS_POR_CRÉDITO = 12.000`, que cubre una
  respuesta típica con historial y herramientas. Se calibra con datos reales.
- **Peso por modelo** (para que un crédito siempre nos cueste parecido, ~$2–2,5 CLP como
  máximo):

  | Nivel de IA | Modelos | Créditos por respuesta |
  |---|---|---|
  | Estándar | gpt-4o-mini, claude-haiku | 1 |
  | Avanzado | claude-sonnet | 3 |
  | Premium | claude-opus | 5 |

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

### 5. Propuesta de precios (inicial; calibrar con los datos reales del punto 7)

Precios en CLP + IVA, siempre editables desde el catálogo, nunca en el código.

| Producto | Créditos | Precio | CLP por crédito | Equivale aprox. a* |
|---|---|---|---|---|
| Prueba gratis | 300 | $0 | — | 30–50 conversaciones |
| **Plan Base mensual** | **1.500** | **$18.900/mes** | 12,6 | 150–250 conversaciones |
| Recarga | 500 | $6.900 | 13,8 | 50–80 conversaciones |
| Pack | 2.000 | $24.900 | 12,5 | 200–330 conversaciones |
| Pack | 5.000 | $54.900 | 11,0 | 500–830 conversaciones |
| Pack | 15.000 | $149.900 | 10,0 | 1.500–2.500 conversaciones |

\* Con IA estándar y 6–10 respuestas por conversación.

**Márgenes a consumo pleno** (peor caso: todo el saldo gastado con el costo máximo por
crédito, ~$2,3 CLP):
- Plan Base: costo IA ~$3.450 + infraestructura ~$3.000 + Flow ~$750 ≈ $7.200 → **margen
  ~62%**. Con gpt-4o-mini el costo de IA baja a ~$900 y el margen sube a ~75%.
- Packs: costo máximo ~$2,3 por crédito contra $10–13,8 de precio → **margen 77–83%**
  antes de Flow.
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
- **Recarga automática** (ya existe; se adapta a créditos): "cuando queden menos de X
  créditos, compra el pack Y", con **tope mensual de gasto obligatorio**. Requiere tarjeta
  guardada con Flow, que entrega la Etapa 0 del copiloto.
- **Gracia:** 150 créditos (≈ las 20 conversaciones de hoy). El bot **nunca queda mudo de
  golpe**: al agotar la gracia responde con la frase de respaldo y deriva a una persona,
  como hoy.
- **Estimador visible** en Inicio, Cobros y en el copiloto: medidor de créditos más
  "≈ N conversaciones · ~D días".

### 7. Dato que falta: el costo real por conversación en producción

`ai_requests` guarda tokens y costo de cada llamada a la IA. Para calibrar
`TOKENS_POR_CRÉDITO`, los pesos y los precios, hay que correr el script de solo lectura
`packages/database/scripts/_tmp_ai_cost_stats.cjs`. Saca, por modelo, la mediana y el
percentil 90 de llamadas, tokens y costo por conversación, y los mensajes por conversación.
No lee datos de clientes, solo agregados. Una vez usado se puede borrar.

### 8. Decisiones del dueño

1. **Unidad:** ¿aprobado "Créditos IA" con 1 respuesta estándar = 1 crédito?
2. **Precios:** la tabla del punto 5 como punto de partida, ajustada con los datos reales.
3. **Modelo estándar de los bots de clientes:** gpt-4o-mini (margen mayor) o Claude Haiku
   (mejor calidad en español y agenda). La plataforma permite cambiarlo por agente.
4. **Clientes actuales:** se convierten a 10 créditos por cada conversación que les quede
   (las 30 de prueba pasan a 300) y nadie pierde saldo.

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
- Pesos por nivel de modelo configurables (estándar 1 / avanzado 3 / premium 5) y mapeo
  modelo → nivel. Si un modelo no tiene nivel, se cobra como premium y se levanta una alerta
  al super admin.
- No debitan créditos: el copiloto y el asistente del panel, las respuestas humanas, los
  mensajes sin respuesta de IA, las plantillas y recordatorios.
- `serviceDebitsWallet` apagado en los planes nuevos de Conversia (Meta le cobra directo
  al cliente). El cobro de servicio de TuBot no cambia.
- Tests: fórmula (bordes del bloque de tokens, pesos), idempotencia, gracia, vencimiento,
  saldo concurrente (dos turnos a la vez), y que TuBot no cambie.

### Etapa 2 — Catálogo, migración y cobro
- Catálogo nuevo: plan Base con créditos incluidos, prueba de 300 créditos y packs de la
  Parte A §5, sembrados con el script idempotente de catálogo. Los planes y packs de
  conversaciones se desactivan para ventas nuevas, sin borrarlos.
- Migración de saldos: conversaciones restantes × 10 = créditos, con su vencimiento
  original, en un script con **dry-run por defecto** que imprime el antes y el después por
  organización. Asiento auditado por cada conversión. Nadie pierde saldo.
- Auto-recarga adaptada a packs de créditos (tope mensual obligatorio, como hoy).
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
- typecheck, tests, sim250 y Playwright en verde. Playwright "dueño nuevo": prueba con 300
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
