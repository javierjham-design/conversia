# Prompt de desarrollo: packs con bono, cobro automático con Flow y tarjeta de crédito

> Fecha: 29-oct-2026. Va ANTES del go-live de Créditos IA. Reemplaza la decisión del
> 28-oct de "una sola recarga, sin packs" (`packsEliminados` en el catálogo).
> TuBot está en producción: nada de esto puede cambiar su cobro ni su funcionamiento.

---

**Actualización Créditos IA antes del go-live: packs con bono, cobro automático con Flow, tarjeta de CRÉDITO obligatoria para lo automático y ajuste del respaldo de IA.**

Objetivo: que ningún cliente de Conversia se quede sin bot por falta de créditos. Si tiene tarjeta de crédito cargada, el plan y las recargas se cobran solos. Si no la tiene, se le avisa antes y se le da un link para pagar.

## 1) Catálogo: packs con bono escalonado (IVA incluido)

En `packages/database/seeds/creditos-catalogo.json`:

| code | Precio | Créditos | Bono | ≈ conversaciones (4,5 créditos/conv) |
|---|---|---|---|---|
| `conversia-cred-420` | $24.990 | 420 | — (recarga básica) | ≈ 93 |
| `conversia-cred-880` | $49.900 | 880 | +5% | ≈ 195 |
| `conversia-cred-1850` | $99.900 | 1.850 | +10% | ≈ 411 |
| `conversia-cred-2900` | $149.900 | 2.900 | +15% | ≈ 644 |

- El plan Base ($24.990 con 300 créditos), la prueba (200), la gracia (100) y el tope de recarga automática (249.900 CLP al mes) **no cambian**.
- Agregar a cada pack el campo `bonoPct`, que alimenta el texto "+5% de créditos extra".
- Actualizar el `_doc` y `packsEliminados`: los packs vuelven, pero con un bono chico. Así un cliente del tamaño de Digital-Dent sigue pagando entre $175.000 y $200.000 al mes (Base + pack de $149.900, más una recarga si es un mes fuerte).
- `apps/api/test/creditos-catalogo.spec.ts`: el piso de 300% de ganancia sobre costo tiene que pasar con los 4 packs. Ya pasa con mucha holgura: el pack de $149.900 deja ~1.900% con el costo conservador de $2,1 por crédito.
- `creditos-golive.mjs` y la siembra deben crear los packs nuevos de forma idempotente. Correr de nuevo no duplica.
- **Una sola fuente de verdad:** nada de precios o créditos escritos a mano en el front. Los "respaldos" de `page.tsx` e `inicio/page.tsx` deben coincidir con el catálogo. Agregar un test que lo exija, como el que ya existe para el tope.

## 2) Página pública conversia.cl y panel del cliente

**Página pública (`apps/conversia-web/src/app/page.tsx`)**
- La sección de precios muestra el plan Base y las 4 recargas con su bono, "≈ N conversaciones" (mismo estimador del medidor) e "IVA incluido".
- Destacar el pack de $49.900 como "Más elegido" y el de $149.900 como "Mejor precio por crédito".
- **Corregir la pregunta frecuente desactualizada** (línea ~358). Hoy dice "30 conversaciones gratis"; debe leer la prueba del catálogo: 200 créditos ≈ 44 conversaciones.
- Agregar preguntas frecuentes:
  - **"¿Cómo se paga?"**: el plan y las recargas se cobran con Flow. Para el cobro automático se necesita **tarjeta de crédito**. Las de débito y prepago no permiten cargos automáticos; con ellas se paga con link cada vez.
  - **"¿Qué pasa si se me acaban los créditos?"**: avisamos al 75% y al 90%. Con recarga automática no pasa nada. Sin ella, el bot sigue 100 créditos de gracia y después se pausa hasta recargar.
  - **"¿Los mensajes de WhatsApp los cobran ustedes?"**: no. Meta los cobra aparte, a la tarjeta del cliente.
- "Sin tarjeta" para la prueba **se mantiene**: la tarjeta se pide al activar el plan, no para probar.

**Panel (`/inicio` y `/cobros`)**
- **Compra manual de un pack:** checkout de Flow (`payment/create`). Acepta cualquier medio, incluido débito, porque el pago es único.
- **Configuración de recarga automática:**
  - interruptor de encendido;
  - pack a recargar (por defecto $24.990, elegible entre los 4);
  - umbral (por defecto: menos de 50 créditos);
  - tope mensual en CLP.
  - Si la próxima recarga excede el tope, no se cobra y se avisa.
- **Estado de la tarjeta visible siempre:**
  - "Tarjeta de crédito •••• 1234 — cobro automático activo ✅";
  - o "Tarjeta no apta para cobro automático (débito/prepago) ⚠️ — cámbiala por una de crédito", con botón para registrar otra.

## 3) Super admin: configuración de planes y paquetes

- En la pantalla de catálogo del super admin, los packs deben ser editables:
  - precio;
  - créditos;
  - `bonoPct`;
  - activo/inactivo;
  - orden;
  - marcar "recarga básica".
- Toda edición queda auditada.
- **Validación al guardar:** rechazar un pack que no cumpla el piso de 300% de ganancia sobre costo, con el mismo cálculo del test. También rechazar si se rompe el orden (un pack más caro no puede dar menos créditos por peso).
- **Ficha del cliente:** mostrar tipo de tarjeta, últimos 4 dígitos, si es apta para cobro automático, el pack de recarga elegido, las recargas del mes y el tope.

## 4) Cobro automático con Flow: tarjeta de CRÉDITO obligatoria

Hoy ya existe: `flowRegisterCard` (`customer/register`), `flowCollect` (`customer/collect`), `flowCustomerGet`, y el diagnóstico del super admin en `platform.controller.ts` (~línea 2727). Ese diagnóstico ya dice que un cobro con tarjeta de débito queda "pendiente" en Flow. El problema es que **el cliente nunca se entera**: el cobro se queda pendiente en silencio y después el bot se corta.

**a) Antes de registrar:** en la pantalla que abre el registro de tarjeta de Flow, texto claro:
> "Usa una **tarjeta de CRÉDITO**. Las tarjetas de débito y prepago (incluida Redcompra) no permiten cobros automáticos, y tu asistente podría pausarse al quedarse sin créditos."

**b) Después de registrar (retorno de Flow):**
- Leer `flowCustomerGet` (`creditCardType`, `last4`).
- **Primero verificar en el sandbox de Flow qué devuelve** con tarjeta de crédito y con tarjeta de débito, y documentarlo en el PR.
- Si el tipo permite identificar débito o prepago, marcar la suscripción con `autoChargeable = false` en ese momento.

**c) Si no se puede detectar al registrar:** el primer cobro automático (`customer/collect`) es la prueba. Si Flow lo deja "pendiente" o lo rechaza por el tipo de tarjeta:
- marcar `autoChargeable = false`;
- generar un link de pago (`payment/create`) por el mismo monto, reutilizando el de `payment-link` (~línea 2775), y enviarlo por correo y en el panel;
- levantar `raiseException` del tipo `tarjeta_no_apta_cobro_automatico` (warning, dedupe por organización);
- Convi lo menciona en la próxima interacción.

**d) Avisos preventivos:** si `autoChargeable = false` o no hay tarjeta, los avisos del 75% y del 90% llevan el link para comprar un pack y la recomendación de registrar una tarjeta de crédito. Si hay recarga automática activa y apta, el aviso dice "se recargará automáticamente".

**e) Robustez del cobro:**
- `commerceOrder` único e idempotente; el webhook de Flow acredita una sola vez.
- Si el webhook llega duplicado o tarde, no se duplican créditos.
- Un cobro pendiente no dispara otro cobro (ya hay una guardia para esto en `subscription-billing/engine`: reutilizarla).
- **Rechazo de tarjeta de crédito** (sin cupo, vencida): reintentar según la política actual de la suscripción, sin inventar una nueva; avisar al cliente y al super admin.
- **Tope mensual:** si se alcanza, no se cobra más y se avisa.

## 5) Agente de implementación (Convi)

Archivos: `apps/api/src/assistant/setup-logic.ts`, `setup-tools.ts` y `actions.ts`.

**Etapa de pago**
- Cambiar el texto actual ("Activa tu plan o deja tu tarjeta para que no se corte") por algo como:
  > "Deja una **tarjeta de CRÉDITO** para que tu plan y tus recargas se cobren solos. Con tarjeta de débito no se pueden hacer cobros automáticos, y si se te acaban los créditos tu asistente se pausa hasta que recargues."
- Convi debe:
  1. explicar la diferencia crédito/débito en una frase y sin jerga;
  2. abrir `/cobros` destacando el registro de tarjeta;
  3. al volver de Flow, leer el estado de la tarjeta y confirmar ("listo, tu tarjeta de crédito •••• 1234 quedó para cobros automáticos") o advertir si no es apta;
  4. **proponer activar la recarga automática** y recomendar el pack según el consumo esperado o real, el más chico que cubra el mes;
  5. si el cliente no tiene tarjeta de crédito, explicar el plan B (pagar con link cada vez, con aviso previo) sin dejarlo bloqueado.

**Checklist de montaje:** el paso "pago" queda ✅ solo si el plan está pagado **y** hay tarjeta apta con recarga automática activa. Si pagó con débito o con link, queda en estado "⚠️ pagado, sin cobro automático" y Convi lo vuelve a recordar (sin insistir en cada mensaje: como máximo una vez por día).

**Meta:** en la explicación de los dos cobros (ya existe en `setup-tools.ts` ~línea 380), agregar: "En Meta también conviene una tarjeta de crédito; muchas de débito chilenas no sirven para pagos internacionales recurrentes."

**Aviso de saldo bajo:** si el cliente pregunta por saldo o los créditos están bajo el 25%, Convi lo dice con el estimado ("te quedan ≈ N conversaciones") y ofrece el botón de recarga.

## 6) No cobrar al cliente el respaldo automático del modelo

En `apps/worker/src/agent-turn.ts` (~línea 855), `debitAiCreditsForTurn` recibe el modelo que respondió (`result.model ?? runtime.model`). Cuando `RoutingAIProvider` cae a `SAFE_MODEL` por falla de clave o proveedor (pasó del 24 al 29 de octubre con la clave OpenAI revocada), el turno se cobraría con peso 4 (Haiku) aunque el agente esté configurado con gpt-4o-mini (peso 1).

- **Regla:** créditos = `creditsForTurn` con el peso **menor** entre el modelo configurado (`runtime.model`) y el que respondió. Tokens y costo USD se registran reales; el sobrecosto lo absorbemos nosotros.
- Guardar en `usage_events.meta` los campos `configuredModel`, `respondedModel` y `fallback`.
- Cuando hay respaldo, `raiseException` del tipo `respaldo_ia_activo` (warning, dedupe por proveedor por día). Estuvimos 5 días con la clave revocada sin enterarnos.
- Tests:
  - configurado mini y responde Haiku por respaldo → 1 crédito por bloque;
  - configurado Haiku y responde Haiku → 4;
  - modelo desconocido → se mantiene premium más alerta.

**Extra:** cuando el super admin cambie el modelo de un agente, mostrar el gasto mensual estimado con el modelo nuevo (créditos de los últimos 30 días × peso nuevo ÷ peso actual). Si supera el tope de recarga automática del cliente, advertirlo antes de confirmar.

## 7) Criterios de aceptación (probar en el sandbox de Flow, end-to-end)

1. **Tarjeta de crédito:**
   - se registra y el panel muestra "cobro automático activo";
   - se cobra el plan Base;
   - al consumir hasta bajo 50 créditos, la recarga automática cobra el pack elegido y acredita exactamente sus créditos, una sola vez aunque el webhook llegue dos veces.
2. **Tarjeta de débito:** queda marcada como no apta (al registrar o al primer cobro). El cliente ve la advertencia, recibe el link por correo y el super admin ve la excepción. **El bot no se corta sin aviso previo.**
3. **Tope alcanzado:** no hay más cobros y llega el aviso.
4. **Compra manual** de cada uno de los 4 packs: créditos y bono correctos.
5. **Coherencia:** la página pública, `/cobros`, `/inicio`, Convi y el super admin muestran los mismos precios, créditos y conversaciones estimadas.
6. **TuBot:** sin cambios de comportamiento. Los tests de su cobro siguen verdes.

De paso, corregir `CLAUDE.md`: dice que el modelo por defecto es `claude-opus-4-8`, pero el default real de los bots de cliente es `gpt-4o-mini` (`CREDIT_POLICY_SEED.defaultModel`).

Entregar con PRs separados si conviene (catálogo/front, Flow, Convi, respaldo). Al final, una tabla con el estado de cada punto. Los despliegues de api y worker los hace el dueño (conversia-web se autodespliega).
