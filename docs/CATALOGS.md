# Catálogo comercial

Que los agentes de IA lean y vendan con el **catálogo real** de cada cliente: productos
de su tienda (WooCommerce, Shopify, …) o el menú de su restaurante (Fudo). El agente
consulta **un único catálogo normalizado**; no sabe de qué fuente vienen los datos.

## Modelo normalizado (`catalog_items`)

Sirve igual para un producto de tienda y para un plato de restaurante, y unifica el
catálogo manual de Servicios.

| Campo | Uso |
|---|---|
| `source` | `manual` · `csv` · `woocommerce` · `shopify` · `fudo` · `jumpseller` · `bsale` · … |
| `externalId` | id en la fuente (null para manual). `@@unique(org, source, externalId)` → upsert idempotente |
| `kind` | `product` · `dish` · `service` |
| `sku`, `name`, `description` | identidad |
| `botDescription` | descripción optimizada para el bot (la del sitio no siempre vende en WhatsApp); no toca la tienda |
| `category`, `subcategory`, `menuSection` | organización (menú de restaurante en su orden) |
| `price`, `compareAtPrice`, `currency` | precio y precio antes de descuento |
| `stock`, `trackStock`, `available` | stock real y disponibilidad |
| `active` | el bot lo ofrece (toggle del tenant) |
| `variants`, `availability` | variantes/modificadores; ventanas por horario y precios por canal (restaurante) |
| `imageUrl`, `productUrl`, `buyUrl` | imagen, enlace y enlace de compra/carrito armado |
| `serviceId` | enlace al Servicio de agenda cuando `kind=service` |
| `raw` | objeto crudo original |
| `embedding vector(1536)` | búsqueda semántica (pgvector + índice HNSW) |

Registro de sync: `catalog_sync_runs` (mode full/incremental/webhook; created/updated/deactivated/failed).

## Cómo agregar un adaptador

Implementar `CatalogAdapter` (`apps/worker/src/catalog/types.ts`): `testConnection`,
`fetchAll(onPage)`, `fetchSince(since, onPage)`, `normalize(raw)`. La normalización a
`NormalizedItem` debe ser **pura** (testeable con fixtures, sin HTTP). El motor de sync
upsertea por `(org, source, externalId)` y marca como no disponible lo que desaparece del
origen. Nada más toca el resto del sistema.

## Proveedores — investigación (2026-08) y qué necesita el cliente

### WooCommerce ✅ (implementado)
- **Auth**: Basic con `consumerKey` + `consumerSecret`. El cliente los genera en
  **WooCommerce → Ajustes → Avanzado → REST API → Crear clave** (permisos **Lectura**).
- **Endpoint**: `GET {tienda}/wp-json/wc/v3/products?per_page=100&page=N` (total en header
  `X-WP-Total`). Incremental con `modified_after`. Webhooks nativos por producto (se
  desactivan tras 5 fallos). Rate limit: paginamos de a 100 + backoff ante 429/5xx.
- **El cliente nos entrega**: URL de la tienda + consumerKey + consumerSecret.

### Shopify (diseñado; decisión abajo)
- **Cambio 2026**: los *custom apps* nuevos se crean en el **Dev Dashboard** (no en el
  admin) y el auth por access token para custom apps nuevas se está apagando a favor de
  **OAuth**. Además Shopify **prioriza la GraphQL Admin API** (REST en desmantelamiento).
- **Recomendación**: implementar contra **GraphQL Admin API**, con **app personalizada por
  tienda vía Dev Dashboard** (el comerciante crea la app, instala, nos entrega el token).
  Dejar el camino **OAuth app pública** documentado para más adelante (implica revisión de
  Shopify). Rate limit GraphQL = puntos por consulta (bucket que se rellena).
- **El cliente nos entrega**: dominio `*.myshopify.com` + access token de la app.

### Fudo (restaurante; gestión con Fudo abajo)
- **Dos APIs**: *inyección de pedidos* (crear órdenes + leer catálogo) y *propósito general*
  (más completa). Para LEER el menú nos basta el catálogo.
- **Auth**: el restaurante debe **pedir a soporte de Fudo que habilite la API** para su
  cuenta; luego en **Administración → Usuarios**, crea un usuario dedicado y "Establecer API
  Secret" → token. **El token vence a los 10 días**; se **renueva por la misma API** (hay
  que automatizar la renovación).
- **Homologación**: la API de propósito general está disponible (plan Pro) y el
  **restaurante entrega SUS propias credenciales** → nuestra lectura del menú **no requiere
  ser partner homologado**. Si Fudo pusiera trabas para cuentas de terceros, es gestión del
  dueño (hablar con Fudo). **A confirmar con Fudo**: acceso de lectura con credenciales del
  propio restaurante + política de renovación del token.
- **El cliente nos entrega**: token de API (y lo renovamos nosotros antes de los 10 días).

### Mercado chileno / otros — prioridad por esfuerzo × mercado
| Proveedor | API | Prioridad |
|---|---|---|
| **WooCommerce** | REST simple (key/secret) | ✅ hecho |
| **Jumpseller** (CL) | REST con API key, muy usado en Chile (nativo de Flow) | Alta (siguiente) |
| **Bsale** (CL) | REST con token, ERP/boletas muy usado | Alta |
| **Shopify** | GraphQL, app por tienda | Media-alta |
| **Tiendanube/Nuvemshop** | REST + OAuth, fuerte en LatAm | Media |
| **VTEX** | appKey/appToken, enterprise | Baja (pocos, complejos) |
| **PrestaShop / Magento** | webservice key / REST OAuth | Baja |

## Fuentes sin integración (para no dejar a nadie afuera)
- **CSV**: plantilla descargable + mapeo de columnas asistido (reutiliza el import de contactos).
- **Manual**: el módulo de Servicios actual, unificado como `source=manual`.

## Unificación con Servicios (DECISIÓN — migración a aplicar con tu OK)
El módulo de Servicios (`services`) es hoy un catálogo manual con enfoque de **agenda**
(`durationMin`, profesionales, precios por sede). Plan:
1. `catalog_items` es el **catálogo único** que consulta el agente.
2. El módulo manual escribe en `catalog_items` con `source=manual`, `kind=service`.
3. **Backfill** (migración de datos, con tu OK + backup): copiar cada `service` activo a
   `catalog_items` (source=manual, kind=service, serviceId=<id>), sin borrar `services`.
4. `services` **se mantiene** para la agenda (duración, profesionales, sedes); `catalog_items`
   guarda el enlace `serviceId`. Así **no se rompe** a los tenants que ya usan Servicios ni el
   agendamiento; el agente pasa a leer `catalog_items` (que incluye los servicios).

## Crear pedidos (DECISIÓN — no implementado, requiere tu OK)
Esta pasada cubre **leer, cotizar, recomendar y enviar enlaces de compra**. **Crear pedidos**
en el sistema del cliente (orden en Fudo, pedido en Woo/Shopify) es un salto de alcance y
riesgo (escribir en un tercero, pagos, errores, anulaciones):
- **WooCommerce/Shopify**: técnicamente directo (POST orders), pero abre pagos, stock,
  anulaciones y responsabilidad sobre el pedido.
- **Fudo**: la *API de inyección de pedidos* está pensada justo para esto, pero suma la
  homologación y el manejo de comandas/mesas.
- **Recomendación**: **después**. Primero validar que el bot vende bien LEYENDO el catálogo y
  mandando el enlace de compra (que ya convierte sin sacar al cliente de WhatsApp). Crear
  pedidos se aborda como programa aparte, por proveedor, cuando haya tracción.
