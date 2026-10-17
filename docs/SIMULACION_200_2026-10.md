# Simulación de producción — 200 clientes (17-oct-2026)

Segunda corrida grande sobre el entorno local aislado (PG 18 + Redis portables, IA y
WhatsApp mock), esta vez **con el rol de BD de producción** (`conversia_app`, sin
BYPASSRLS; admin solo para register/billing como en prod) — es decir, RLS de verdad.

**Escala**: 200 organizaciones (104 trial con 20 % dormidas, 40 base contratadas POR LA
API con pago mock, 6 agotamiento, 6 con pack comprado por API, 6 Asistente Plus, 6 V1,
10 TuBot de control, 4 países, autorecarga, free tier ×3, fusible, ola 2, dup-wamid,
teléfono cruzado, demo, upgrade en vuelo, migración V1→V2, cancelación, seguridad,
4 de montaje profundo). **7.844 mensajes, 3.476 conversaciones, 3.366 débitos,
3.514 service sends (30 con costo sobre free tier)**.

## 1. Resultado por área (todo verificado end-to-end)

| Área | Resultado |
|---|---|
| Registro masivo 200 orgs (gate de marca + regalo 30 + wallet en época) | 200/200 OK |
| Contratación/upgrade/packs **por la API** (checkout → mock-confirm) | OK (79 upgrades + 6 packs) |
| Agotamiento: 124 convs → lote 100/0, gracia 20, deriva a humano, excepción en cola | PASS ×6 |
| Asistente Plus debita ×2 | PASS (14 convs → 28 créditos) |
| Migración V1→V2 por API (cortesía 100, idempotente) | PASS |
| **Free tier 1.000 POR NÚMERO** (pedido explícito): 178 contadores independientes; sobre el límite registra costo (USD 0,02/msj) y el panel `/billing/v2` lo muestra | PASS ×3 orgs |
| Fusible servicio por tenant/día (techo 12 → corta en 12) | PASS |
| Cancelación: el bot sigue hasta el fin del período pagado | PASS |
| Seguridad: email duplicado 409, login malo 401, cuenta por marca, cero fuga cross-tenant, RLS directo (rol app sin contexto ve 0 filas) | PASS |
| Caja bajo rol append-only real (idempotencia, reversa, cierre, net correcto) | PASS ×4 |
| Dedupe wamid · aislamiento de contactos por org | PASS |
| TuBot de control: 0 débitos V2, 0 efectos (los "marks" son contador inerte sin impacto de cobro — verificado) | PASS |
| **Montaje completo**: checklist real, plantillas HSM por rubro, reinstalación idempotente, asistente in-app (contexto + chat), ciclo del agente borrador→simulador→publicar→activar, panel V2 + simulador de costos, assisted-setup degrada sin Meta | PASS ×4 orgs |

## 2. Bugs reales encontrados y CORREGIDOS en esta corrida

| # | Bug | Fix | Retest |
|---|---|---|---|
| 6 | **Upgrade dentro del mismo período acreditaba 0 conversaciones** — el funnel normal (nace trial, paga base el mismo día): el cliente pagaba $18.900 y quedaba bloqueado al agotar la gracia, sin su lote de 100 hasta el mes siguiente. | `conversation-credits.ts`: acreditación idempotente por **(plan, período)** vía ledger, no solo por fecha de wallet. Test unitario nuevo. | PASS (lote 100/100 tras upgrade, summary 120) |
| 7 | **`mock-confirm` abierto en producción con Flow/Lemon** — el guard solo miraba `STRIPE_SECRET_KEY`; con Flow (Chile) cualquier tenant podía activarse planes y packs GRATIS por API. | Se bloquea en producción si hay **cualquier** pasarela real configurada (env o platform_settings). | Guard probado por tests de API |
| 8 | **Doble acreditación de packs** con doble confirmación mock (lotes 2/800): la idempotencia descansaba en `providerRef` y mock no mandaba ninguno. | `mock-confirm` ahora pasa ref determinístico por día. Webhooks reales ya eran idempotentes. | PASS (doble confirm → 1 lote) |
| 9 | **El checklist de implementación no pedía cargar el método de pago** (pedido explícito del negocio). | Paso "Cargar tu método de pago" en `/onboarding` (7 pasos) y en el asistente in-app (4 pasos; no sale de modo implementación sin él). Done = tarjeta guardada o factura pagada. | PASS |
| 10 | **Los `customFields` de las plantillas verticales nunca se instalaban** (letra muerta en todas las plantillas). | Loader nuevo `loadCustomFields` (upsert por org+entity+key), llamado por el instalador. | PASS (abogados instala 6 campos) |

## 3. Rubro nuevo: ABOGADOS / ESTUDIO JURÍDICO (v2, vendible)

Plantilla v2 creada (ola 1, activa — se instala al registrarse) orientada a **captación
de casos**: pipeline nuevo→contactado→calificado→consulta agendada→propuesta→contratado;
3 servicios de consulta (presencial pagada / online / urgencia); calificación por materia,
urgencia, comuna y **contraparte (conflicto de interés)**; 6 campos de intake en la ficha;
agente de recepción formal e confidencial que NO da asesoría legal y filtra con consulta
pagada (se descuenta de honorarios); 6 documentos FAQ; tags por materia; HSM con el
vocabulario del rubro (Reunión/Consultante).

**E2E verificado**: registro con `vertical: "abogados"` instala todo (3 servicios, agente,
6 docs, 6 campos, etapas nuevas), el bot atiende y debita del regalo, la reinstalación es
idempotente y las plantillas sugeridas usan el vocabulario correcto.

## 4. Brecha WABA — propuesta para hacer el montaje directo

Hoy el alta de WABA con Meta es el mayor punto de fricción (verificación del negocio,
Business Manager, número). Lo que existe y lo que propongo, en escalera:

1. **Día 0 — número de prueba de Conversia** (ya contemplado en V2-3): la cuenta nace
   operando sobre un número sandbox del Tech Provider; el cliente ve a su bot funcionar
   de inmediato (el simulador del panel ya lo permite sin número).
2. **Su número actual sin dolor — Coexistencia (QR)**: Meta permite conectar un número
   que ya usa la app WhatsApp Business escaneando un QR, sin perder el teléfono ni los
   chats (modo coexistence del Embedded Signup). **Hoy NO está implementado en el repo**
   — es la pieza que más reduce fricción para pymes y recomiendo priorizarla.
3. **Número dedicado — Embedded Signup completo**: ya existe por API (`/assisted-setup`:
   authorize, generate-link, revoke) pero **falta el botón/flujo en el panel del cliente**
   (brecha ya levantada en PROMPT_AJUSTES_CANAL_ASISTENTE.md, Bloque A). El popup de Meta
   hace todo dentro de Conversia; el asistente in-app guía y el paso "método de pago"
   (nuevo) queda exigido antes de activar el número propio.

Con esa escalera el cliente SIEMPRE tiene bot vivo (1), conecta su número real en minutos
(2) y migra a número dedicado cuando madura (3).

## 5. Decisiones pendientes (Javier)

- [ ] **Ola 2 / gimnasio**: el gate bloquea `gimnasio` porque exige la feature
      `groupClasses` (clases con cupos) que aún no existe — ni el registro ni el tenant
      pueden instalarlo. Opciones: ocultarlo del selector de rubros hasta construir la
      feature, o publicar una variante reducida sin clases grupales. Los demás de ola 2
      (taller, veterinaria, kinesiología, medspa, psicología, servicios a domicilio) solo
      requieren subirlos a ola 1 si quieres venderlos en el registro.
- [ ] **Coexistencia QR**: ok para priorizar su implementación (punto 4.2).
- [ ] Checklist pre-lanzamiento del informe anterior sigue vigente
      (SIMULACION_PROD_2026-10.md §4): `whatsappRateSchedule` en PROD, `db:seed` +
      `v2-golive`, Redis ≥ 6.2, antiabuso de registro.

## 6. Artefactos de la sim (no son bugs de producto)

- 70 `[ERROR] psql` y las ráfagas `ECONNREFUSED`: SQL del harness (columnas slug/updated_at)
  y reinicios de la API al aplicar los fixes en caliente durante la corrida; reintentados.
- `tubot-contaminado ×10`: assert demasiado estricto — los `conversation_quota_marks` son
  un contador idempotente sin efecto de cobro (plan free sin features, 0 notifs, todo SENT).
- HTTP 201 en los asserts de montaje/migración: Nest devuelve 201 en POST (esperábamos 200).
- `upgrade-mid`/`pack-151` fallaron en la corrida principal y quedaron **verdes en Q7**
  tras los fixes 6 y 8.

Resultados crudos: `sim200-results.json` / `sim200-findings.json` (scratchpad de la sesión).
