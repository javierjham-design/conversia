# Simulación de producción — Conversia V2 (octubre 2026)

**Qué se hizo**: simulación grande de producción en un entorno local 100 % aislado
(Postgres 18 portable en puerto 5433 + Redis portable + `AI_PROVIDER=mock` +
`WHATSAPP_PROVIDER=mock`): cero gasto real, cero contacto con producción ni con TuBot.
**40 organizaciones** cubriendo todos los escenarios (trial, base, agotamiento, packs,
V1 funcional, TuBot de control, país CO, Asistente Plus, autorecarga, free tier,
fusibles, demo, teléfono cruzado, wamid duplicado). Volumen: **1.689 mensajes,
982 conversaciones, 264 débitos de conversación, 395 service sends**.

Estado: fases p1–p5 ejecutadas, hallazgos triados, **5 fixes aplicados con tests**
(worker 284/284, API 175/175, typecheck limpio) y fase p6 de retest post-fix.

---

## 1. Lo que funcionó bien (verificado end-to-end)

| Flujo | Resultado |
|---|---|
| Registro Conversia (Origin → marca) + regalo de 30 conversaciones | OK tras FIX-5 |
| Débito 1 crédito = 1 conversación, idempotente por conversación | OK (264 débitos, 0 dobles) |
| FIFO de lotes con expiración (plan 2 meses, compra 12 meses) | OK |
| Gracia de 20 → bloqueo con frase de respaldo + derivación (bot nunca mudo) | OK |
| Avisos 75 % / 90 % / gracia (notifications `credits.low` / `credits.grace`) | OK |
| Excepción `saldo_gracia_sin_recarga` en cola del super admin (dedupe mensual) | OK |
| Dedupe de wamid (mensaje entrante duplicado no genera doble turno) | OK |
| Aislamiento de contactos por organización (mismo teléfono, 2 orgs) | OK |
| Caja: entrada idempotente, reversa, cierre de día (sumas BD correctas) | OK |
| Agenda: crear y cancelar citas con recursos de paquete | OK |
| TuBot intacto: sin débitos V2, sin packs de conversación, planes actuales | OK |

## 2. Bugs reales encontrados y corregidos (en este branch)

| # | Bug | Fix |
|---|---|---|
| 1 | **El primer período del plan nunca acreditaba**: la wallet nacía con `periodStart = now` (default `now()` del schema) y `ensurePeriodAccrued` creía que ya estaba acreditado → los primeros clientes de pago habrían consumido TODO por gracia y quedado bloqueados en la conversación 21 pese a tener 100 pagadas. El bug tenía **cuatro puntas**: `ensureWallet` del worker y tres `create` de la API que no fijaban `periodStart` (regalo de registro en `auth.service`, compra de pack y cortesía de migración en `billing.controller`). | La wallet nace con `periodStart = época` ("nunca acreditada") en los 4 sitios → el primer débito acredita el lote del plan. Test unitario nuevo + retest E2E (R0/R1: lote 100/0 tras 120 conversaciones). |
| 1b | El medidor `/billing/wallet/summary` de la API mostraba "consumido 100 de 100" a una org recién contratada (la acreditación es perezosa: el lote real nace con el primer débito). | El summary suma la **acreditación pendiente** del período como display (sin escribir dinero): compara período de wallet vs suscripción igual que el worker. |
| 2 | El resumen de billetera (`/billing/wallet/summary`) podía mostrar saldo 0 antes del primer débito del período (no acreditaba al leer). | El summary ahora acredita el período (con `FOR UPDATE`) antes de leer el saldo. |
| 3 | La nota SYSTEM de "techo alcanzado" se creaba con `status=SENT, visibility=PUBLIC` → aparecía como mensaje enviado al cliente final sin serlo. | `messaging-guard.ts`: ahora `DELIVERED` + `INTERNAL` (nota interna del equipo). |
| 4 | El catálogo V2 (planes `conversia_v2_trial`/`base` + packs de conversación) solo existía por SQL manual → un ambiente nuevo (o re-seed) quedaba sin catálogo. | `packages/database/src/seed.ts`: planes y packs V2 sembrados `active:false`; `v2-golive.mjs` los enciende. El seed no toca `active` (respeta go-live). |
| 5 | `brandFromOrigin` comparaba el Origin por igualdad exacta de string → una barra final o mayúscula en el env hacía caer el registro de Conversia **en silencio** a TuBot (lo vivimos en la sim: 40 orgs nacieron tubot). | `packages/config/src/brands.ts`: comparación normalizada (minúsculas, sin `/` final, trim). |

## 3. Falsos positivos (artefactos del entorno de sim, no bugs)

- **"Fuga" entre orgs en la caja**: la sim corría como superusuario de Postgres, que
  salta RLS. En producción la app usa un rol sin bypass → sin fuga. (Recomendación:
  futuras sims con rol no-superusuario para ejercitar RLS de verdad.)
- **"El fusible de techo 12 no frenó"**: el INSERT del setting omitía `updated_at`
  (NOT NULL) y fallaba en silencio → el techo nunca existió. Retest p6 con INSERT válido.
- **"No hay notificaciones"**: la consulta usaba una columna inexistente (`event_key`);
  la real es `type`. Las notificaciones sí estaban.

## 4. Acciones de producción pendientes (checklist pre-lanzamiento)

- [ ] **Verificar `whatsappRateSchedule` sembrado en PRODUCCIÓN** (platform_settings).
      Sin él, todo envío de servicio sobre el free tier registra costo **$0** — la tabla
      base trae `service: 0`. En la sim lo reprodujimos: sin seed, cero costo.
- [ ] Correr `pnpm db:seed` tras mergear este branch (crea catálogo V2 inactivo)
      y luego `node packages/database/scripts/v2-golive.mjs` para encenderlo.
- [ ] **Decisión de negocio — verticales ola 2**: el registro por API instala solo
      ola 1; si el cliente elige un vertical de ola 2, el gate lo omite **en silencio**
      (sin error, sin contenido instalado). El contenido de ola 2 ya existe en
      templates. Opciones: habilitar ola 2, o que el gate devuelva error/instale
      el genérico. Hoy el cliente queda con cuenta vacía sin saber por qué.
- [ ] Antiabuso de registro: límite actual ~10 registros/IP. Razonable para el
      lanzamiento; subirlo o bajar la ventana si hay campañas con tráfico alto
      compartiendo IP (oficinas, CGNAT móvil).
- [ ] Redis de producción ≥ 6.2 (BullMQ lo advierte con versiones menores).

## 5. Entorno de simulación (reproducible)

- Postgres 18 portable: `C:\Users\Javier\pgtools\pgsql`, datos en
  `C:\Users\Javier\pgtools\simdata` (puerto 5433, DB `conversia_sim`;
  `vector(1536)` degradado a `text` y sin índices hnsw — no afecta lo probado).
- Redis portable: `C:\Users\Javier\pgtools\redis`.
- Harness: `sim-harness.mjs` (fases p1–p6) + `sim.env` en el scratchpad de la sesión.
- Entrada mock: `POST /webhooks/whatsapp` con header `x-conversia-mock-token` y
  `phone_number_id: "mock:<slug>"`.

## 6. Retests post-fix (fases p6–p9) — TODOS PASS

| Retest | Qué valida | Resultado |
|---|---|---|
| R0 | La wallet nace "nunca acreditada" (`period_start` = época) al registrarse | **PASS** |
| R1 | El primer débito acredita el lote del plan (100) end-to-end | **PASS** (lote 100/0) |
| R2 | Agotamiento real: 120 convs → 100 de lote + 20 de gracia, débitos=120 | **PASS** |
| R2b | Avisos 75 % / 90 % / gracia | **PASS** (3 notifs) |
| R2c | Conversación 121 → excepción `saldo_gracia_sin_recarga` (dedupe mensual) | **PASS** |
| R2e | Sobre la gracia NO se debita (121–123 sin asiento) | **PASS** |
| R2f | El bot no queda mudo: frase de respaldo a las bloqueadas | **PASS** |
| R2g | Deriva a humano (`ai_enabled=false`) en las bloqueadas | **PASS** |
| R2d | `/billing/wallet/summary` refleja gracia y saldo −20 | **PASS** |
| R3 | Fusible servicio por tenant/día (techo 12) → corta en 12, resto FAILED | **PASS** (sent=12, failed=8) |
| R4 | Sobre el free tier (1.000) **con saldo**: envía, registra costo (tarifa sembrada) y debita la bolsa por envío | **PASS** (8 asientos con costo, balance 500→492) |
| R4-sin-saldo | Sobre el free tier **sin saldo**: bloquea ANTES de enviar con mensaje de recarga (comportamiento diseñado, no bug) | **Verificado** |
| R5 | Regresión TuBot: sin débitos V2 ni packs de conversación en su catálogo | **PASS** |

Nota de la corrida p6: R1/R2 fallaron ahí porque el register de la API aún creaba la
wallet con el default `now()` (punta #1 del bug que faltaba por tapar) y R4 falló por
secuencia del propio test (el fusible de R3 seguía cacheado 60 s). Ambos quedaron
verdes en p7–p9 tras el fix y el reorden.
