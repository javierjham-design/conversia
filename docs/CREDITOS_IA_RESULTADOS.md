# Créditos IA — qué quedó construido

Entregable de `docs/MODELO_COBRO_CREDITOS_IA.md` (Parte B, "Cierre"). Se actualiza al
cerrar cada etapa.

| Etapa | Estado | PR |
|---|---|---|
| 1 — Motor de Créditos IA | ✅ construida (apagada) | #557 |
| 1b — Selector de modelo del super admin + aceptación del cliente | pendiente | |
| 2 — Catálogo, migración y cobro | pendiente | |
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

**Falta de esta etapa, en un PR aparte:** el selector de modelo en tu consola que muestre
el peso en créditos y, antes de aplicar uno más caro, le mande al cliente el aviso con el
impacto estimado y el botón "Acepto". La función que traduce el cambio a lenguaje del
cliente ("tus 1.000 créditos rinden ~60 conversaciones en vez de ~240") ya está escrita y
probada.

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

### Nada que aplicar en producción

- **Sin migración**: usa las tablas del monedero que ya existen.
- **Sin variables de entorno nuevas.**
- Lo único opcional: correr el script de siembra de la política. Si no lo corres, el
  código usa los mismos valores calibrados por defecto, así que tampoco es urgente.
