# Simulación 250 clientes + auditoría de seguridad total (madrugada 17-oct-2026)

Corrida pre-lanzamiento pedida por Javier: 250 clientes con los **14 rubros**, entorno
idéntico a producción endurecida (rol `conversia_app` sin BYPASSRLS, admin solo para
register/billing), compras y upgrades **por la API** con pago mock, batería de seguridad
ofensiva, y revisión de interfaz con navegador real. **Resultado: cero hallazgos de
producto en la corrida final** — todo lo encontrado en la auditoría previa quedó
corregido y validado por la propia simulación.

**Escala**: 250 orgs · 8.117 mensajes · 3.620 conversaciones · 3.510 débitos ·
3.633 service sends (24 con costo sobre free tier) · avisos: ai.escalation 24,
credits.low 12, credits.grace 6 · excepciones: saldo_gracia_sin_recarga 6.

## 1. Seguridad — 16/16 ataques repelidos (fase W6)

| Ataque | Resultado |
|---|---|
| Inyección de inbound al webhook sin token / token falso | 403/403 |
| Enrutar mensajes a una org conociendo solo su slug (sin canal MOCK) | descartado |
| JWT forjado / petición sin token | 401/401 |
| Tenant accediendo a la consola de plataforma (/platform/*) | 401 |
| Caja: montos negativos o cero | 400 |
| Caja: reversar un asiento de OTRA org por ID (IDOR de dinero) | 404 |
| Caja: clave de idempotencia repetida entre orgs | cada org su asiento |
| Compra cross-marca (conversia→pack tubot y viceversa) | 400/400 |
| Migración V2 desde una org TuBot | 400 |
| Auto-recarga con pack de mensajes (no de conversaciones) | 400 |
| **Carrera de débitos: 12 mensajes PARALELOS del mismo cliente** | **1 débito, 1 mark** |
| Replay del mismo wamid ×10 | 1 mensaje |
| Registro con `brand`/`organizationId` inyectados en el body | ignorados (marca = Origin) |
| IDOR de contacto ajeno | 404 |
| Ráfaga de 35 pruebas del simulador de agentes (quema de tokens) | 429 desde la 31 |
| Rol de BD de la app sin contexto de tenant (RLS directo) | 0 filas |

## 2. Fixes de seguridad/robustez aplicados esta noche (antes de la corrida)

| # | Problema | Fix |
|---|---|---|
| S1 | **Webhook: la ruta mock funcionaba en PRODUCCIÓN** con el token por defecto (público en `.env.example`) → cualquiera inyectaba mensajes a un tenant conociendo su slug: le quemaba créditos e IA ("trucaje de tokens" inverso). | En producción con proveedor real la ruta mock queda CERRADA aunque el token coincida; y sin `META_APP_SECRET` el webhook real queda **fail-closed** (antes pasaba sin validación). |
| S2 | El worker enrutaba `mock:<slug>` a CUALQUIER org por slug, sin exigir canal MOCK. | Sin canal MOCK el mensaje se descarta (defensa en profundidad). |
| S3 | **Caja: todas las lecturas confiaban solo en RLS** — y producción hoy conecta como superusuario (RLS no aplica): `GET /cash/day` devolvía la caja de TODAS las orgs y `reverse` permitía reversar asientos ajenos (IDOR de dinero). | `organizationId` explícito en entry/reverse/day/report/export/close/closures. **Además**: el runbook activa RLS real en prod (rol `conversia_app`, ya existente) — toda esta corrida se ejecutó así. |
| S4 | El simulador de agentes no tenía rate limit (quema tokens reales del proveedor en loop). | 30 pruebas / 5 min por usuario (429). |
| S5 | `buy-package` no validaba la MARCA del pack (cross-brand). | Pack con marca solo para orgs de esa marca. |
| S6 | `conversia-sobre-500` estaba sembrado como pack TuBot (brand faltante en el seed). | brand `conversia` explícita. |
| S7 | `GET /billing/wallet` ofrecía a cuentas V2 el sobre V1 de 500 MENSAJES al mismo precio que la recarga de 100 conversaciones → compra equivocada hacia una bolsa que su plan no consume. | El catálogo de packs filtra por el MODELO de la cuenta (conversación vs. mensaje). |

## 3. Funcional — todo PASS (fases W1–W5, W7)

- **Registro masivo**: 250/250 con smoke gate (gimnasio v2 desde seed puro, wallet en época, regalo 30).
- **Montaje completo en los 14 rubros**: checklist de 7 pasos (incluye "Cargar tu método
  de pago"), plantillas HSM por rubro, reinstalación idempotente, asistente in-app
  (contexto + chat), ciclo del agente borrador→simulador→publicar→activar, panel V2,
  assisted-setup degrada sin Meta. 14/14 PASS.
- **Upgrade en vuelo** (trial→base mismo día): lote 100 acreditado, gracia 0. PASS.
- **Agotamiento ×6**: exacto 100+20, excepción en cola, deriva a humano, bot nunca mudo.
- **Free tier 1.000 POR NÚMERO**: 224 contadores independientes; sobre el límite cobra
  (USD 0,02/msj) en CL/CO; con saldo del sobre V1 debita por envío.
- **Fusible por tenant/día**: corta exacto en el techo.
- **Cancelación**: el bot sigue hasta el fin del período pagado.
- **Invariante de dinero**: débitos = conversaciones contadas × multiplicador en
  **199/199 orgs** (Plus ×2 incluido). TuBot 0 débitos V2.
- Pack idempotente (doble confirm = 1 lote), migración V1→V2 (cortesía 100), sobre V1
  con marca corregida acredita a la bolsa de mensajes.

## 4. Interfaz (smoke con navegador real + fixes)

- **Landing** V2 renderiza completa (precios por conversación, "se arma solo").
- **Registro por UI de punta a punta**: selector muestra los 14 rubros EN VIVO desde el
  catálogo; cuenta creada con "Estudio jurídico" entra directa al panel con 30/30 y el
  paquete completo instalado (3 servicios, 6 campos, 6 docs).
- **Login + panel**: saludo por hora, saldo de prueba correcto, conversaciones estilo
  WhatsApp con badges.
- Fixes de UI aplicados:
  - **CSP** bloqueaba el runtime de Next en dev (`unsafe-eval` solo-dev agregado; en
    producción no se emite — la landing/panel prod no cambian).
  - **Tarjeta de créditos**: mostraba "0 de 0 usados" a cuentas de prueba y ofrecía el
    sobre V1 a cuentas V2; ahora muestra el saldo de prueba y el CTA correcto por modelo.
  - **Botón de tema** rompía la hidratación (SSR Luna vs cliente Sol → re-render completo
    con flash); ahora el tema se lee tras montar.
- Nota (no bug): `is_public` de los planes NO es filtro de listado (Enterprise TuBot y
  los V1 gestionados son is_public=false y se muestran adrede). El "Base duplicado" del
  smoke era el plan clonado por el harness.

## 5. Para mañana

1. **Mergear el PR de esta noche** (checks verdes) — el deploy es automático.
2. Correr `docs/RUNBOOK_GOLIVE_V2.md` (7 pasos): hardening RLS (rol `conversia_app` en
   api/worker — validado por toda esta corrida), `db:setup`, `db:seed`, `v2-golive`,
   tarifa de servicio, chequeo de variables de seguridad y humo de 2 minutos.
3. Con eso: plataforma lista para la campaña — catálogo de 14 rubros, montaje
   autoservicio completo, cobro por conversación blindado y sin brechas conocidas.

Resultados crudos: `sim250-results.json` / `sim250-findings.json` (scratchpad de la sesión).
