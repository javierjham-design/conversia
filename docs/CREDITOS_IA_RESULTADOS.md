# Créditos IA — qué quedó construido

Entregable de `docs/MODELO_COBRO_CREDITOS_IA.md` (Parte B, "Cierre"). Se actualiza al
cerrar cada etapa.

| Etapa | Estado | PR |
|---|---|---|
| 1 — Motor de Créditos IA | ✅ construida (apagada) | #557 |
| 1 — Selector de modelo + aceptación del cliente | ✅ construida | #557 |
| 2 — Catálogo y migración de saldos | ✅ construida (inactiva) | #558 |
| 2 — Recarga automática con tarjeta | ✅ construida | #559 |
| 3 — Transparencia y avisos | pendiente | |
| 4 — Margen y calibración | pendiente | |

---

## Lo primero que hay que saber: está apagado

El motor **no le cobra créditos a nadie todavía**. Debita solo si el plan del cliente
tiene `features.aiCreditsWallet`, y **ningún plan del catálogo lo trae**. Se enciende en
la Etapa 2, cuando apruebes activar el catálogo nuevo.

Mientras esté apagado, para los clientes actuales no cambia nada: siguen pagando por
conversación exactamente como hoy.

## Etapa 1 — Motor de Créditos IA (PR #557)

### Cómo se cobra

Por **cada respuesta del bot**, con los tokens que realmente usó ese turno (la respuesta,
las rondas de herramientas y cualquier clasificación) y el modelo que **efectivamente**
respondió:

```
créditos = peso_del_modelo × máx(1, techo(tokens_del_turno / 20.000))
```

Una respuesta normal del bot estándar cuesta **1 crédito**. Solo las muy cargadas
—historial largo, varias herramientas— suman más.

Esto es lo que arregla el problema que diste con los datos de producción: una sola
conversación con Opus costó USD 13 y, cobrando por conversación, pagaba **1 crédito
(~$200)**. Ahora paga lo que corresponde a sus tokens y a su modelo.

### Valores sembrados

Están en `platform_settings.aiCredits` y los cambias ahí **sin desplegar** (el worker y la
API releen la fila cada 60 segundos). Se siembran con:

```
DATABASE_URL=... node packages/database/scripts/seed-ai-credits-policy.mjs
```

| Valor | Sembrado | Qué controla |
|---|---|---|
| `tokensPerCredit` | 20.000 | Tamaño del bloque: cada bloque cuesta un peso completo |
| `graceCredits` | 100 | Hasta cuánto sigue respondiendo el bot con saldo en 0 (≈ 25 conversaciones) |
| `defaultModel` | `gpt-4o-mini` | Modelo con el que nace todo bot nuevo |
| `models` | ver abajo | Peso en créditos por modelo |
| `unknownModel` | premium (50) | Qué se cobra si responde un modelo sin peso definido |

Pesos por modelo (los del §4, calibrados con tus mediciones del §7):

| Nivel | Modelo | Créditos por respuesta |
|---|---|---|
| Estándar | `gpt-4o-mini` | 1 |
| Plus | `claude-haiku-4-5` | 4 |
| Avanzado | `gpt-4o` | 12 |
| Avanzado | `claude-sonnet-4-6` | 20 |
| Premium | `claude-opus-4-6/4-7/4-8`, `claude-fable-5` | 50 |

`claude-fable-5` no estaba en tu tabla; entró como premium porque por precio de lista es
~2× Opus. A la mezcla de tokens mediana sale ~$1,9 por crédito, dentro de la meta.

Hay un test que **falla** si alguien agrega un modelo a `pricing.ts` y se olvida de
ponerle peso, y otro que falla si algún peso deja el crédito por encima de $2,5 CLP. Son
las dos formas en que este cobro se desalinea solo con el tiempo.

### Lo que NO cobra

- El copiloto de montaje y el asistente del panel (son nuestro costo de venta).
- Las respuestas que escribe una persona desde la Bandeja.
- Los mensajes entrantes sin respuesta de IA.
- Plantillas y recordatorios (esos los cobra Meta a la tarjeta del cliente).
- **Un turno que no llegó a llamar al modelo** (proveedor caído, modo degradado): cero
  tokens, cero créditos. Nuestras caídas no se le cobran al cliente.
- Un plan con las dos unidades encendidas por error cobra **solo** Créditos IA, nunca las
  dos cosas. Igual con el cobro por mensaje de servicio: con Créditos IA se apaga, porque
  ese mensaje lo paga el cliente a Meta con su tarjeta.

### El bot nunca queda mudo

Antes de generar la respuesta se verifica que quede saldo o gracia. Si se agotaron las
dos, el turno **no llama al modelo** (no gastamos tokens que no podemos cobrar) y el
cliente recibe la frase de respaldo configurada del tenant, con la conversación derivada a
una persona y una excepción crítica en tu consola de operación.

### Garantías que quedaron probadas

- **Nadie paga dos veces la misma respuesta:** el débito se sella con el id del turno, así
  que un reintento de la cola no vuelve a cobrar.
- **Dos turnos a la vez no gastan el mismo saldo:** los débitos de una organización se
  serializan con un cerrojo de base de datos.
- **Un lote vencido no paga** y se consume siempre primero el que vence antes.
- **Un turno caro que no cabe en la gracia no consume nada**, ni lotes ni gracia.
- **TuBot no entra por ninguna puerta** (marca + feature del plan, dos guardas).

De paso se cerró un hueco del núcleo anterior: al pasarse de la gracia, vaciaba los lotes
y recién después bloqueaba, así que esos créditos desaparecían del libro sin asiento. No
se podía llegar ahí con el flujo normal, pero un ajuste manual tuyo sí lo permitía — y con
Créditos IA el débito ya no es de 1 en 1, que es justo cuando aparece.

### El modelo lo elige la plataforma, no el cliente

Según tu decisión del 27-oct:

- Todo bot nuevo nace con el modelo estándar, **leído de configuración**.
- `PUT /agents/:id/draft` **ignora** cualquier cambio de modelo en orgs Conversia y lo
  deja auditado (`agent.model_change_rejected`). Esconder el selector en el panel no
  alcanzaba: ese endpoint recibe el `config` completo, así que un cliente podía pasarse a
  Opus con `curl` y multiplicar por 50 su consumo sin saberlo.
- Un agente que ya tiene un modelo avanzado (porque tú lo activaste) lo conserva: el
  cliente no puede subirlo ni bajarlo al guardar.
- El copiloto no tiene herramienta para cambiar el modelo (se verificó: la herramienta de
  montaje asistido no expone ese campo).
- TuBot sigue exactamente como estaba.

### Cómo se activa un modelo más potente

En la ficha del agente, en tu consola, **cada opción del selector dice cuánto consume**
("gpt-4o · 12 créditos por respuesta"), y las premium quedan marcadas como no
autoservicio. Elegir un modelo **más caro** ya no lo aplica de inmediato:

1. Al cliente le llega un aviso (en el panel y por correo) con el impacto en **su** saldo
   real: "cada respuesta consumiría 12 créditos; con tu saldo te alcanzaría para ~19
   conversaciones en vez de ~238".
2. El bot **sigue con el modelo que tenía** mientras el cliente no responda.
3. En su Inicio el cliente ve el aviso con **Acepto** / **No, gracias**. Su decisión queda
   registrada con fecha y usuario (`agent.model_change_accepted` o `_declined`).
4. Si necesitas aplicarlo sin esperar, hay un **"Aplicar igual"** que exige escribir el
   motivo, y ese motivo queda guardado (`platform.agent.model_forced`).

**Volver al modelo estándar** (o a cualquiera más barato) se aplica al instante: nadie
tiene que aceptar que le baje el consumo.

La aceptación se exige **solo** en planes que cobran Créditos IA. Con el cobro por
conversación, cambiar el modelo no cambia lo que paga el cliente, así que el aviso "tus
créditos rinden menos" sería falso — y mandarle un aviso equivocado a un cliente real es
peor que no mandarlo. En esos planes el cambio se aplica como siempre.

### Para ti: los agentes que usan gpt-4o

El encargo pide revisar qué agentes usan gpt-4o desde el 14-oct. **No sale de ningún seed
ni del código** (lo verifiqué: el único `gpt-4o` del repo es su peso en la política), así
que se fijó agente por agente desde el super admin o por API. Eso solo se ve en la base de
producción, que no toco. Esta consulta es de **solo lectura**:

```sql
SELECT o.name AS organizacion, o.brand, a.name AS agente, a.slug,
       av.config->>'model' AS modelo, av.status, av.published_at
FROM agent_versions av
JOIN agents a ON a.id = av.agent_id
JOIN organizations o ON o.id = av.organization_id
WHERE av.config->>'model' IS NOT NULL
  AND av.config->>'model' <> 'gpt-4o-mini'
  AND av.status IN ('PUBLISHED', 'DRAFT')
ORDER BY o.brand, o.name, a.name;
```

Con Créditos IA, un agente en gpt-4o consume **12 créditos por respuesta** en vez de 1.
Decide tú si queda así (porque lo vale) o vuelve al estándar; no cambié ninguno.

## Etapa 2 — Catálogo y migración de saldos (PR #558)

### El catálogo, con tus precios

Sembrado **INACTIVO**. Los precios viven en
`packages/database/seeds/creditos-catalogo.json` —no en el código— y son los que aprobaste
el 27-oct (§5 opción B, IVA incluido):

**Precios vigentes: los del 28-oct** (el criterio pasó de costo a VALOR; el cálculo completo
está en `MODELO_COBRO_CREDITOS_IA.md` §8.3).

| Producto | Créditos | Precio | Ganancia sobre costo | ≈ conversaciones |
|---|---|---|---|---|
| Prueba gratis | 200 | $0 | — | ~48 |
| **Plan Base** mensual | 300 | **$24.990/mes** | 313% | ~67 |
| **Recarga** (única) | 420 | **$24.990** | 1.045% | ~93 |

Gracia: 100 créditos. **No hay packs con descuento por volumen.** No se siembran los de
1.000 / 3.000 / 6.000 / 8.500 / 16.000 (catálogo del 27-oct, reemplazado) ni los de
1.150 / 2.500 / 5.000 / 11.000 / 20.000 (no cumplían la regla de ganancia).

Está calibrado para que una cuenta con el uso real de Digital-Dent en septiembre-2026
(3.172 créditos) pague **$199.920** al mes: el plan más 7 recargas. El plan Base ya **no
necesita la excepción del 260%**, pero es el que queda más al límite: con el crédito 20%
más caro cae a 303%.

Las columnas "≈ conversaciones" usan **4,5 créditos por conversación**, que es el valor
MEDIDO en septiembre (3.172 créditos en 727 conversaciones = 4,36) redondeado hacia arriba.
El catálogo y el estimador del panel comparten ese número y hay un test que lo exige: antes
el estimador usaba 9 y le mostraba al cliente menos de la mitad de lo que su saldo rinde.
Ver `MODELO_COBRO_CREDITOS_IA.md` §8.4.

**Hay un test que encierra tu regla**: calcula la ganancia de cada pack con las tres partes
del costo (créditos, comisión de Flow y, en el plan, el costo fijo por cliente) y falla si
alguno baja del 300%. Si mañana se edita un precio, o si el dólar sube y hay que
recalibrar, te enteras ahí y no en el reporte de margen tres meses después.

Ese mismo test encontró un detalle del documento: el **260%** del plan Base es el redondeo
de **259,94%** (sale de sus propios números: $4.434 de costo contra $15.958 netos). No
cambia ninguna decisión, pero el test compara redondeado para no perseguir centésimas.

### Migrar los saldos (×10)

`node packages/database/scripts/creditos-migrar-saldos.mjs` — **dry-run por defecto**: sin
`--aplicar` no escribe nada, solo imprime el antes y el después por organización.

- Cada conversación que le quede al cliente pasa a **10 créditos**, con su vencimiento
  original. Como una conversación consume ~4,2 créditos, todos ganan saldo.
- La **gracia usada también se multiplica**: si alguien debía 4 conversaciones, debe 40
  créditos. Si no, le perdonaríamos deuda en una unidad y se la cobraríamos en la otra.
- **Idempotente por organización**: al convertirla queda un sello y la corrida siguiente se
  la salta. El sello es por organización y no por lote a propósito: si fuera por lote, un
  pack que el cliente comprara *después* de migrar se vería como "sin convertir" y se le
  multiplicaría otra vez.
- El libro queda **cuadrado asiento por asiento** (saldo real después de cada movimiento),
  no con un total al final: así se puede auditar de dónde salió cada crédito.
- Los lotes vencidos no se tocan. TuBot no se toca.

### Encender el modelo nuevo

`node packages/database/scripts/creditos-golive.mjs` (y `OFF=1 …` para volver atrás).
Activa los planes y packs de créditos, y **deja de vender** los de conversación sin
borrarlos: quien ya los tiene sigue operando igual. Antes de encender **avisa si queda
saldo sin convertir**, porque ese cliente gastaría su saldo diez veces más rápido de lo que
le corresponde.

El plan de prueba de las cuentas nuevas se elige por **el plan que está activo**, así que
encender el catálogo y que los registros nuevos entren al modelo nuevo son la misma acción:
no hay un segundo interruptor que pueda quedar desfasado.

### Probado contra una base de datos real

No solo typecheck: levanté un Postgres, apliqué las migraciones y corrí los scripts. Quedó
verificado que la siembra deja todo inactivo, que correrla dos veces no cambia nada, que el
dry-run no escribe, que la migración convierte bien (y la segunda corrida se salta), y que
el go-live y su rollback dejan el catálogo como estaba.

### Tres cosas que estaban mal y se arreglaron

1. **Volver a correr el seeder del catálogo apagaba el plan que está vivo en producción** y
   lo sacaba de los precios públicos — los registros nuevos se quedaban sin nada que
   contratar. Ahora un plan ya activo no se apaga desde una siembra: eso lo decide el
   go-live.
2. **Un pack de créditos habría acreditado la bolsa de plantillas** en vez de los lotes: el
   cliente pagaba y recibía saldo que su bot no puede gastar.
3. **Al activar los créditos, el cliente perdía el medidor de su Inicio** (la pantalla
   miraba solo la unidad vieja).

## Recarga automática con tarjeta (PR #559)

**Lo primero: esto no existía.** Había dos endpoints de configuración desde V2-2, pero
**nada disparaba la recarga y tampoco había pantalla donde activarla**. Un cliente no
podía usarla ni enterarse de que existía.

Ahora: cuando el saldo baja de **50 créditos** (≈12 conversaciones), se cobra la **recarga
de $24.990 (420 créditos)** a la tarjeta guardada con Flow. Se dispara antes de llegar a
cero para que el bot no se corte mientras el pago se procesa. El tope por defecto son **10
recargas al mes** ($249.900), editable por el cliente: el cliente de referencia necesita 7
en un mes, así que el tope anterior de 3 le habría cortado el bot a mitad de mes.

Como esto **cobra plata de verdad**, cada forma de que salga mal tiene su freno, y cada
freno tiene su test:

| Riesgo | Freno |
|---|---|
| Cobrar sin permiso | **Consentimiento explícito y registrado** (fecha + usuario). Sin él no se cobra, aunque el interruptor esté encendido. Al desactivar se borra: volver a encenderla exige aceptar de nuevo. |
| Cobrar de más | **Tope mensual obligatorio** (por defecto 3 recargas = $56.970). Se mide con el cobro incluido, así que un tope de 3 permite exactamente 3. Al alcanzarlo se avisa una vez y no se cobra más. |
| Cobrar varias veces seguidas | **Un cobro a la vez.** El saldo sigue bajo hasta que el webhook confirme, y el tick corre cada 15 min: sin este freno se cobrarían varios packs. Los pendientes también cuentan contra el tope. |
| Cobrar y que el pack no llegue | El cobro viaja con la metadata que el webhook necesita para acreditar (`pkg:<pack>` + monto esperado), por el **mismo camino idempotente** que una compra manual. Hay test de que esa metadata va. |
| Tarjeta rechazada | Intento marcado como fallido y **aviso inmediato** al cliente. El bot sigue con la gracia, que existe justo para esto. |
| Vender saldo inservible | Un pack inactivo o de otra unidad no se cobra. |

### Un riesgo que encontré al construirlo

Los cobros de recarga y los de la mensualidad viven en la **misma tabla** y van a la misma
tarjeta. Si el motor de suscripciones hubiera visto los de recarga, pasaban dos cosas:

1. **Le habría renovado el mes gratis** al cliente: la reconciliación toma cada cobro
   pendiente, le pregunta a Flow y, si salió bien, extiende el período y acredita el plan.
   Una recarga cobrada se habría leído como "pagó la mensualidad".
2. **Habría frenado la mensualidad** mientras una recarga estaba en vuelo.

Los cobros de recarga llevan el prefijo `rec-` y las dos consultas del motor los excluyen.
Hay un test que mira las consultas que se emiten de verdad (es la única forma de pinchar
algo que vive en un `where`), y lo verifiqué quitando la exclusión a propósito: se cae.

### Lo que ves y lo que ve el cliente

- En **Cobros** hay una tarjeta nueva: dice exactamente qué se cobra, con qué tope y cuántas
  recargas son, con la casilla de autorización que hay que marcar para activarla. Sin
  tarjeta guardada, lo dice en vez de ofrecer un botón que no funciona.
- Tres avisos nuevos: **se recargó** (con monto y créditos), **la tarjeta falló** (inmediato,
  también por WhatsApp) y **se alcanzó el tope** (una vez al mes).

### Lo que falta

Nada de esta etapa. Queda la Etapa 3 (medidor, estimador y avisos al 75/90/0%) y la 4
(margen por cliente).

### Nada que aplicar en producción

- **Sin migración**: usa las tablas del monedero que ya existen.
- **Sin variables de entorno nuevas.**
- Lo único opcional: correr el script de siembra de la política. Si no lo corres, el
  código usa los mismos valores calibrados por defecto, así que tampoco es urgente.

## Etapa 3 — Transparencia y avisos (#563)

### El estimador y el medidor

Un saldo en créditos no significa nada para el dueño. Ahora en Inicio, en Cobros y en el
copiloto se ve **"1.240 créditos ≈ 140 conversaciones ≈ 18 días a tu ritmo"**, y cada
estimación dice de dónde salió el número.

Cómo se calcula, y por qué así:

- **Promedio de SUS últimas conversaciones** (30 días), con un **mínimo de 20**. Por debajo
  de eso el promedio propio es ruido: tres conversaciones, una larga con un modelo caro, y
  el dueño vería "te quedan 5 conversaciones" cuando le quedan cien. Con muestra chica se
  usa el promedio del rubro; si el rubro tampoco tiene datos suficientes (al menos 3
  negocios y 30 conversaciones), uno general.
- **Redondea siempre hacia abajo.** Que el saldo dure más de lo prometido es una buena
  sorpresa; lo contrario es un bot que se corta sin aviso.
- **Los días salen del ritmo propio**, aunque el promedio por conversación venga del rubro:
  el rubro dice cuánto cuesta una conversación, no cuántas tiene este negocio por día. Sin
  consumo propio no se muestran días en vez de inventar una cifra.
- **Un solo cálculo para las cuatro superficies** (panel, Cobros, copiloto y avisos): la
  aritmética en `@conversia/agents` y la muestra en una sola consulta de
  `@conversia/database`. Si cada una lo hiciera a su manera, el dueño vería "≈ 18 días" en
  pantalla y "≈ 6 días" en el aviso del mismo momento, y dejaría de creerle a las dos.

### Dos bugs que encontré y arreglé

**1. Un cliente de Créditos IA no recibía NINGÚN aviso de saldo.** Los avisos de 75%, 90% y
gracia vivían solo dentro del camino del cobro por conversación. La Etapa 1 desactivó ese
camino para los planes de créditos —correcto, para no cobrar dos veces— y con eso el aviso
desapareció: el bot se le paraba sin una sola advertencia previa, que es el peor momento
posible para enterarse. Ahora el débito por turno dispara el aviso, con el estimado dentro
("te quedan ≈ N conversaciones"), reutilizando `lastNotifiedPct` del mismo monedero: una vez
por umbral y período, sin estado nuevo ni migración.

**2. Nueve tipos de aviso dejaban al cliente de Conversia en un 404.** El catálogo de
notificaciones nació con TuBot y sus rutas quedaron escritas tal cual: `/inbox?c=…` (el
enlace más usado, el que abre la conversación que espera respuesta), `/billing`,
`/facturacion`, `/settings/plan`, `/contacts`. En conversia-web esas pantallas no existen.
Es el mismo hallazgo que ya se había corregido en el checklist de montaje, vivo todavía en
el camino de los avisos —y peor, porque el del checklist lo ve quien está montando y este lo
ve quien ya está pagando y acaba de recibir un aviso de que su bot se corta. De paso, el
correo armaba el enlace con el dominio de TuBot y firmaba "Abrir en TuBot", así que a un
cliente de Conversia le llegaba un aviso de su propio saldo que lo mandaba a otra marca.

Ahora el enlace y el correo se resuelven por marca, conservando la query que abre la
conversación correcta, y un guardián recorre el catálogo completo: si alguien agrega un aviso
con una ruta que en Conversia no lleva a ninguna parte, falla en CI.

### Costos de Meta

Decisión del dueño (27-oct): **cada cliente paga a Meta con su propia tarjeta**. Eso
significa que le llegan dos cobros y el panel solo le mostraba uno. Ahora en Cobros hay una
tarjeta informativa con lo que Meta cobró en el mes, por categoría, sacada de `usage_events`
y descontando lo que Meta no factura. Dice explícitamente que son dos cobros distintos y que
ese no lo cobra Conversia. Si no hay mensajes cobrados, la tarjeta no aparece: mostrar "$0"
invita a preguntarse por un cobro que no existe.

**La rama activa en producción es "sin línea de crédito"** (cada cliente con su tarjeta en
Meta). La otra —línea de crédito compartida de un Solution Partner, `META_EXTENDED_CREDIT_ID`—
sigue en el código pero inactiva. Si algún día se activa, el texto de `explicarPagoEnMeta` es
lo primero que hay que cambiar: decirle a un cliente que cargue una tarjeta en Meta cuando ya
no hace falta es mandarlo a un trámite inútil.

### Verificación

api 603/603, worker 467/467, agents 106/106, notifications 25/25, conversia-web 62/62, builds
completos. Los cuatro guardianes nuevos se rompieron a propósito para verlos fallar. **Sin
migraciones.**
