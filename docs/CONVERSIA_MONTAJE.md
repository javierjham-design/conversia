# CONVERSIA.CL — CÓMO MONTAR LA NUEVA PLATAFORMA (ANÁLISIS TÉCNICO)

**Fecha:** 2026-09-30
**Decisión de contexto (Javier):** TuBot queda como está. Conversia es una plataforma "nueva" en otro dominio, con interfaz distinta, moderna y muy optimizada en diseño, de alto valor y extremadamente funcional para los verticales que se definan.
**Pregunta:** ¿se monta sobre TuBot, se clona TuBot, o se arma de otra forma?

---

## 0. VEREDICTO

**Un backend, dos frontends.** Conversia debe ser una **nueva app web dentro del mismo monorepo** (`apps/conversia-web`), con diseño 100% propio, desplegada como servicio aparte en conversia.cl, hablando con la MISMA API, base de datos, worker y canal WhatsApp que ya operan TuBot. Lo único que se duplica es la capa visual — que es exactamente lo que quieres que sea distinto. Todo lo que es carísimo de duplicar (WhatsApp Cloud API, RLS, billing, agentes IA, workflows, integraciones) se comparte.

Clonar el repo completo queda **descartado**: es la opción que mata el proyecto a 6 meses.

---

## 1. LAS CUATRO OPCIONES

### Opción 1 — Nueva app web en el monorepo, backend compartido ✅ RECOMENDADA

```
conversia (monorepo, mismo repo GitHub)
├── apps/api          ← compartida (se hace "brand-aware")
├── apps/worker       ← compartido, sin cambios visibles
├── apps/web          ← TuBot, NO SE TOCA
├── apps/conversia-web ← NUEVA: Next.js, design system propio, UX por vertical
└── packages/*        ← compartidos (types, database, agents, workflows, scheduling)
```

- **Cómo funciona:** `Organization` gana un campo `brand` (`tubot` | `conversia`). El registro en conversia.cl crea orgs con `brand: 'conversia'` + su paquete vertical. La nueva app se despliega como un servicio más en Railway con dominio conversia.cl. El backend elige textos/links/remitente según la marca de la org (ver §3).
- **Pros:**
  - TuBot intacto: su app web no se modifica; sus tenants no notan nada.
  - Libertad total de diseño: la app nueva no hereda ni un CSS del panel actual.
  - UX enfocada: puedes construir SOLO las pantallas que el vertical necesita, en el orden que importa (agenda y bandeja primero, no las 40 pantallas del panel actual).
  - Cero duplicación del 80% caro: Meta/WhatsApp, RLS, billing Flow, bolsa prepagada, agentes, tools, workflows, integraciones, omnicanal — un solo lugar, un solo mantenimiento.
  - Una sola infraestructura: misma BD, mismo Redis, mismo worker. El costo marginal es un servicio Next.js más.
  - Los datos viven juntos: Super Admin único, métricas unificadas, el montaje asistido y el MCP sirven para ambas marcas.
  - Si un cliente TuBot quiere "pasarse" a Conversia (o al revés), es cambiar un campo, no migrar una BD.
- **Contras:**
  - La API necesita volverse brand-aware (correos, links, CORS, retornos de Flow) — trabajo acotado pero toca producción de TuBot; requiere cuidado y pruebas (§3).
  - Dos frontends para mantener a futuro (mitigable: extraer hooks/cliente API a un `packages/web-core` compartido cuando aparezca la tercera pantalla repetida — no antes).
  - El monorepo crece (turbo ya lo maneja bien).
- **Esfuerzo estimado:** backend brand-aware ~1–2 semanas; app nueva con el MVP de pantallas del vertical ~4–8 semanas según alcance. Nada bloquea a TuBot mientras tanto.

### Opción 2 — Clonar el repo (fork completo, deployment separado) ❌ DESCARTADA

- **Pros:** libertad absoluta, riesgo cero para TuBot el día 1, mentalmente "limpio".
- **Contras (letales):**
  - Dos bases de código de ~2.000 líneas de schema, worker, 27 tools, 24 pasos de workflow… divergiendo desde el día 2.
  - Cada fix de WhatsApp/Meta/billing/seguridad se hace DOS veces (o se olvida en una — y las de Meta son frecuentes: cambios de precios oct-2026, App Reviews, webhooks).
  - Doble infraestructura: 2 Postgres, 2 Redis, 2 workers, 2 pipelines de deploy → doble costo fijo mensual y doble superficie de fallas.
  - Doble superficie de seguridad con las deudas ya conocidas (KMS, rate limit, pentest) sin resolver — ahora en dos lugares.
  - Para un equipo de una persona es insostenible; es la causa de muerte clásica de productos hermanos.
- **Único escenario donde tendría sentido:** vender una de las dos plataformas como empresa separada. No es el caso.

### Opción 3 — Repo nuevo solo-frontend consumiendo la API existente (headless) ⚠️ VARIANTE POSIBLE

- Igual que la opción 1 pero con la app Conversia en un repositorio Git aparte.
- **Pros:** separación mental total; historia de commits limpia para "el producto nuevo".
- **Contras:** pierdes los tipos compartidos (`@conversia/types`) salvo que los publiques como paquete o uses submódulos — fricción constante; los cambios API+frontend dejan de ser atómicos (un PR ya no puede tocar ambos); CI/CD duplicado.
- **Veredicto:** solo si en el futuro un equipo distinto desarrolla Conversia. Hoy, dentro del monorepo es estrictamente mejor.

### Opción 4 — Plataforma nueva desde cero ❌ DESCARTADA

- Reconstruir WhatsApp Cloud API + Embedded Signup + App Review + RLS + billing + bolsa + agentes son 6–12 meses para llegar a donde ya estás. El valor de Conversia está en el empaque vertical y el diseño, no en reescribir la tubería.

---

## 2. POR QUÉ "INTERFAZ NUEVA" NO EXIGE "PLATAFORMA NUEVA"

La percepción de producto nuevo se construye con exactamente lo que la opción 1 permite:

1. **Design system propio desde cero** en `apps/conversia-web`: tipografía, paleta, densidad, navegación, dark mode — nada compartido con el panel TuBot.
2. **Arquitectura de información por vertical, no por módulo.** El panel TuBot es "todas las herramientas" (estilo Respond.io). Conversia puede ser "el día de tu barbería": hoy-agenda-caja-clientes como home, con el bot trabajando de fondo. Misma API, historia de usuario opuesta.
3. **Menos pantallas, mejor hechas.** El MVP de Conversia no necesita replicar el panel completo: bandeja, agenda, clientes/embudo, catálogo/servicios, configuración guiada del bot, y facturación. Lo avanzado (editor de flujos completo, difusiones, editor fino de agentes) puede seguir siendo "modo avanzado" o llegar después — la API ya lo tiene cuando se necesite.
4. **Onboarding como producto:** registro por vertical → paquete instalado (ver `CONVERSIA_VERTICALES.md` Fase 1) → wizard visual de 10 minutos. Ese es el "alto valor percibido" real, más que cualquier estética.

---

## 3. QUÉ HAY QUE TOCAR EN EL BACKEND (lo único delicado)

Trabajo puntual para que la API sirva a dos marcas sin que TuBot lo note:

1. **Campo `brand` en `Organization`** (default `tubot` → cero impacto en tenants existentes) o tabla `Brand` de plataforma con name, domain, logo, colores, remitente.
2. **Mapa de marcas en config** (`packages/config`): por marca → `WEB_URL`, remitente de correo (`no-reply@conversia.cl`), emisor MFA, asunto de pagos, user-agent. Todo lo que hoy dice "TuBot" hardcodeado (~230 refs, ver auditoría en `CONVERSIA_VERTICALES.md` §1) pasa a leerse del mapa según la org. TuBot conserva sus valores actuales como default.
3. **CORS múltiple** en `apps/api/src/main.ts` (hoy un solo `WEB_URL`).
4. **Links salientes por marca:** correos de invitación/reseteo, retornos de Flow, exports, links del montaje asistido — todos usan hoy `WEB_URL` único; pasan a `brandOf(org).webUrl`.
5. **Meta/WhatsApp: sin cambios.** La app principal ya se llama **"CONVERSIA"** (ID 2024917441656687), así que el popup de Embedded Signup ya muestra el nombre correcto para la marca nueva. Misma WABA-infraestructura, mismos webhooks. (Pendiente heredado: sacar las apps del Business de Digital-Dent Temuco a un Business propio — aplica a ambas marcas por igual.)
6. **Legales por marca:** conversia.cl sirve sus propios términos/privacidad desde la app nueva.
7. **Tenant comercial "Conversia"** con agentes de venta/implementación por vertical (mismo patrón `TUBOT_TENANT.md`; hoy el grant de montaje apunta a una sola org proveedora → parametrizar por marca).

Regla de seguridad para este trabajo: **cada cambio con default = comportamiento actual de TuBot**, y el verificador de RLS + typecheck en CI como red. Nada de esto toca el flujo de mensajes.

---

## 4. ORDEN DE EJECUCIÓN PROPUESTO

1. **Fase A — Backend brand-aware** (§3): campo brand + mapa de marcas + CORS + links. TuBot sigue idéntico (defaults). *~1–2 semanas.*
2. **Fase B — Motor de paquetes verticales** (ya definida como Fase 1 en `CONVERSIA_VERTICALES.md`): es agnóstica a la marca y le sirve también a TuBot.
3. **Fase C — `apps/conversia-web` MVP**: design system + registro por vertical + wizard de onboarding + bandeja + agenda + clientes + settings esenciales + billing. Definir el design system con brief propio (estilo, paleta, tipografía) antes de la primera pantalla.
4. **Fase D — Contenido de los 2 verticales piloto** (dental + barberías) + landing conversia.cl con `/dental` y `/barberias`.
5. **Fase E — Lanzamiento**: campañas por vertical reutilizando el playbook Meta de TuBot; meta de 5 clientes pagando por vertical.

Prerrequisitos que siguen vigentes e independientes (de `CONVERSIA_VERTICALES.md` Fase 0): A3/OBO mensajes de servicio (vencía 30-sep), verificación de correo en registro, W-2 devolución de crédito, prueba de carga.

---

## 5. RIESGOS ESPECÍFICOS DE ESTA VÍA Y MITIGACIONES

| Riesgo | Mitigación |
|---|---|
| Un cambio brand-aware rompe algo de TuBot en producción | Defaults = valores actuales; feature por feature; smoke test del flujo crítico (mensaje entrante → respuesta) tras cada deploy |
| La app nueva tienta a "reconstruir todo el panel" y se eterniza | MVP cerrado por vertical (lista de pantallas de §2.3); lo avanzado se enlaza al panel clásico si hace falta en el intertanto |
| Divergencia de lógica entre los dos frontends | El frontend no tiene lógica de negocio (regla existente: todo server-side con zod); extraer `packages/web-core` recién cuando duela |
| Dos marcas confunden el soporte | `SupportTicket` ya enruta por org; el agente de soporte responde con la marca de la org |
| SEO/identidad: conversia.cl parte de cero | Landing con contenido por vertical desde el día 1; los casos Digital-Dent sirven como prueba social para el vertical dental |

---

## 6. OPCIÓN 1 vs OPCIÓN 3 EN DETALLE (análisis 2026-09-30)

**Premisa que iguala la cancha:** en AMBAS opciones la interfaz es 100% nueva — app Next.js desde cero, design system propio, cero herencia visual de TuBot. El requisito de "interfaz totalmente distinta y moderna" **no discrimina entre 1 y 3**. Lo que discrimina es la mecánica de trabajo: dónde vive el código y cómo se sincroniza con la API.

### 6.1 Tabla comparativa

| Dimensión | Opción 1: `apps/conversia-web` en el monorepo | Opción 3: repo aparte consumiendo la API |
|---|---|---|
| Libertad de diseño | ✅ Total (app nueva) | ✅ Total (app nueva) — empate |
| Tipos compartidos (`@conversia/types`) | ✅ Import directo, siempre sincronizados | ⚠️ Hay que publicarlos (npm privado) o generar cliente OpenAPI; versionado manual |
| Cambio que toca API + UI (lo más común al inicio) | ✅ 1 PR atómico, 1 deploy coordinado por turbo | ❌ 2 PRs en 2 repos + coordinar orden de deploy; ventanas de incompatibilidad |
| CI/CD | ✅ El pipeline existente; turbo cachea | ❌ Segundo pipeline completo (lint, build, deploy, secretos) |
| Velocidad de arranque | ✅ `pnpm dev` levanta api+worker+ambas webs; mocks existentes | ⚠️ Repo nuevo necesita apuntar a una API corriendo (local del monorepo o staging) |
| Riesgo de acoplamiento visual con TuBot | ⚠️ Tentación de importar componentes de `apps/web` | ✅ Imposible por construcción |
| Separación mental / "producto nuevo" | ⚠️ Convive con el código viejo | ✅ Historia de commits limpia, identidad propia |
| Contratar diseñador/frontend externo | ⚠️ Habría que darle acceso a TODO el monorepo (API, billing, seeds, secretos en .env.example) | ✅ Acceso solo al frontend — ventaja real de seguridad |
| Refactors del schema/API | ✅ `pnpm typecheck` rompe en el acto si la UI nueva quedó atrás | ❌ La UI externa se entera en runtime (o al actualizar el paquete de tipos) |
| Evolución futura (equipo separado, venta, spin-off) | ⚠️ Requiere extraer después | ✅ Ya está separado |
| Costo operativo | ✅ Un repo, un board, un flujo de PRs | ❌ Dos de todo |

### 6.2 El costo oculto de la opción 3: el contrato de API

Con repo aparte, la pregunta diaria es "¿cómo sabe el frontend qué forma tienen los datos?". Las tres soluciones y su fricción:

1. **Publicar `@conversia/types` como paquete npm privado** — cada cambio de API exige publicar versión + actualizar en el otro repo. Con la frecuencia de cambios actual (378 PRs en ~2 meses), es fricción diaria.
2. **Generar cliente desde OpenAPI** — la API NestJS hoy no genera spec OpenAPI completa; habría que construir y mantener esa generación primero.
3. **Copiar tipos a mano** — divergencia garantizada; es la opción 2 (clon) en miniatura.

En la fase que viene (construir el MVP de Conversia), **la mayoría de los features tocan API y UI a la vez** (paquetes verticales, registro por vertical, wizard, brand-aware). Es exactamente el peor momento para tener el contrato partido en dos repos.

### 6.3 Los riesgos reales de la opción 1 y cómo se neutralizan

1. **Tentación de importar del panel TuBot** → regla de lint `no-restricted-imports`: `apps/conversia-web` solo puede importar de `packages/*`, jamás de `apps/web`. Es una línea de configuración y el CI la hace cumplir.
2. **Monorepo más pesado** → turbo ya cachea por app; `pnpm dev --filter conversia-web...` levanta solo lo necesario.
3. **"Se siente producto viejo"** → es psicológico, no técnico: carpeta nueva, design tokens nuevos, README propio dentro de la app.

### 6.4 Decisión recomendada: **Opción 1 con disciplina de opción 3**

Construir `apps/conversia-web` dentro del monorepo, pero tratarla COMO SI fuera un repo aparte:

- Prohibido importar de `apps/web` (lint lo bloquea). Solo `packages/types` y, si se justifica, un futuro `packages/web-core` (cliente API + hooks sin estilos).
- Design system propio en la app (`src/design/`): tokens, componentes base, tipografía — cero Tailwind config compartida con el panel TuBot.
- Deploy como servicio Railway independiente con dominio conversia.cl.
- README y convenciones propias dentro de la app.

Así se obtiene lo mejor de ambas: PRs atómicos y tipos sincronizados HOY, y **extraer la app a su propio repo más adelante es trivial** (git subtree/filter-repo sobre una carpeta que nunca dependió de `apps/web`). La puerta a la opción 3 queda abierta sin pagar su costo ahora.

**Único gatillo que cambiaría la decisión a opción 3 desde el día 1:** contratar un equipo/freelance de frontend al que no quieras dar acceso al backend (billing, seeds, lógica de negocio). En ese caso: generar spec OpenAPI + cliente tipado primero, y asumir la fricción del contrato como costo de la separación de accesos.
