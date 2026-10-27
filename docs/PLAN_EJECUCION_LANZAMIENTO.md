# PLAN DE EJECUCIÓN — Lanzamiento de Conversia (orden de trabajo para el desarrollador)

**Fecha:** 27-oct-2026. **Para el desarrollador (Claude Code en VS Code, con agentes).**

Hay tres encargos abiertos que se tocan entre sí. Este documento fija **en qué orden se
ejecutan** y las reglas comunes. Cada paso remite a su documento fuente, que es el que
manda en el detalle:

- **AUD** = `docs/PROMPT_CORRECCIONES_AUDITORIA.md` (correcciones de la auditoría integral;
  etapa 1 ya mergeada en #537).
- **COP** = `docs/PROMPT_COPILOTO_MONTAJE.md` (copiloto de montaje: de la cuenta nueva al
  bot conectado y pagado).
- **CRE** = `docs/MODELO_COBRO_CREDITOS_IA.md`, Parte B (cobro por Créditos IA en vez de
  conversaciones; Meta lo paga el cliente con su tarjeta).

**Cómo trabajar:** una fila de la tabla por sesión, en orden; un PR por fila; al cerrar
cada PR, marca la fila en la tabla de estado del final (y en la tabla del documento fuente
si tiene una). Si una fila depende de una decisión del dueño que no está tomada, sáltala,
déjala anotada y sigue con la siguiente.

## Por qué este orden

1. **Primero blindar lo que ya está en producción.** TuBot tiene clientes pagando y la
   campaña va a traer cuentas nuevas de Conversia: el aislamiento entre clientes y la
   confiabilidad del bot van antes que cualquier funcionalidad nueva.
2. **Después, que el camino del cliente nuevo exista** (COP Etapa 0): hoy un cliente no
   puede terminar con el bot publicado, conectado y pagado.
3. **El dinero se arregla antes de cambiar la unidad de cobro:** AUD 4 (débito fail-closed,
   proveedores de pago) y AUD 6 (doble guarda de marca en la bolsa) tocan exactamente el
   código que CRE va a generalizar.
4. **Los permisos y los canales se endurecen antes de darle herramientas de escritura al
   copiloto** (AUD 5 y 7 antes de COP 1).
5. **Los textos de pago del copiloto se escriben cuando ya existen los Créditos IA**, por
   eso COP 3 va junto con CRE 3.

## Orden de ejecución

| # | Paso | Fuente | Qué resuelve |
|---|---|---|---|
| 1 | Aislamiento entre clientes | AUD Etapa 2 | Filtro de organización explícito; ningún cliente toca datos de otro |
| 2 | Confiabilidad del bot 24/7 | AUD Etapa 3 | Cerrojo por conversación, sin bot mudo ni doble envío, limpieza de colas |
| 3 | Camino a "bot activo y pagado" | COP Etapa 0 | Checklist único, publicar el bot, agente asignado al canal, cobro y tarjeta en conversia-web, borrador de `/crear` aplicado |
| 4 | Dinero | AUD Etapa 4 | Proveedor de pago falso nunca en prod, Lemon/Flow idempotentes, débito fail-closed |
| 5 | Marcas y fusibles | AUD Etapa 6 | Fusibles por marca, doble guarda Conversia en la bolsa, test "TuBot sin cambios" |
| 6 | Motor de Créditos IA | CRE Etapa 1 | Débito por respuesta ajustado por tokens y peso del modelo |
| 7 | Catálogo y migración de créditos | CRE Etapa 2 | Planes y packs nuevos (inactivos), migración con dry-run, auto-recarga |
| 8 | Autenticación y permisos | AUD Etapa 5 | MFA, impersonación, permisos faltantes, sesiones |
| 9 | WhatsApp y canales | AUD Etapa 7 | Propiedad de números, sin token global en tenants, errores de Meta, eco de coexistencia |
| 10 | Copiloto que actúa | COP Etapa 1 | Protocolo de acciones y herramientas del copiloto, modelo propio |
| 11 | Personaje y experiencia | COP Etapa 2 | Avatar "Convi", modo montaje, coach marks, móvil |
| 12 | Transparencia, avisos y pago | CRE Etapa 3 + COP Etapa 3 | Medidor y estimador, avisos por correo/WhatsApp/push, momentos de pago, guía de tarjeta en Meta |
| 13 | IA, frontends y cierre | AUD Etapa 8 | Recuperar contraseña, SSRF de `leerWeb`, CSV seguro, `error.tsx`, seeds seguros |
| 14 | Medición y calibración | CRE Etapa 4 + COP Etapa 4 | Margen por cliente, embudo de montaje, eventos para Meta Ads, Playwright de punta a punta |

Las filas 12 y 14 juntan una etapa de cada documento porque comparten pantallas y datos;
pueden ir en un PR cada una o en dos, a tu criterio, siempre sin mezclar con otras filas.

## Reglas comunes (mandan sobre los documentos fuente si hay conflicto)

1. **TuBot intacto.** Nada cambia para un tenant `brand = tubot` salvo lo que una etapa de
   la auditoría pide explícitamente. Lo nuevo de Conversia nace detrás de
   `brand === "conversia"` y de un feature o flag.
2. **Producción la toca el dueño.** Nada de `railway run`, `railway variables`, psql ni
   scripts contra la BD real. Lo que requiera Railway o datos de producción se entrega como
   pasos en el PR para que el dueño lo ejecute.
3. **Migraciones:** las etapas AUD siguen su regla (sin migraciones; se anotan como
   "requiere OK del dueño"). Las etapas COP y CRE pueden usar migraciones **solo
   aditivas** (tablas o columnas nuevas con default, sin borrar ni renombrar), y el PR lo
   advierte en el título para que el dueño dé el OK antes del merge.
4. **Nada visible a los clientes sin OK del dueño:** el catálogo de Créditos IA se siembra
   **inactivo**, y la migración de saldos corre solo en dry-run hasta que el dueño apruebe
   los precios (`MODELO_COBRO_CREDITOS_IA.md` §8). El script
   `packages/database/scripts/_tmp_ai_cost_stats.cjs` es del dueño para calibrar precios:
   **no lo ejecutes ni lo commitees**.
5. **Publicar conversia-web** tras cada PR que la toque y verificar que el sello de versión
   publicado coincide con `main` (autodeploy de #538).
6. Cada fix o funcionalidad con su test; `pnpm typecheck`, `pnpm test` y las suites
   Playwright en verde; prohibido marcar verde lo que un test o un navegador no vio
   funcionar. Nada de credenciales en texto plano ni en commits.
7. Commitea en el primer PR estos documentos, que hoy están sin seguimiento en git:
   `docs/PLAN_EJECUCION_LANZAMIENTO.md`, `docs/PROMPT_COPILOTO_MONTAJE.md` y
   `docs/MODELO_COBRO_CREDITOS_IA.md`.

## Decisiones del dueño pendientes (no bloquean el inicio)

- Precios y unidad de Créditos IA (`MODELO_COBRO_CREDITOS_IA.md` §8): bloquean solo
  **activar** el catálogo en producción y aplicar la migración, no construir el motor.
- Modelo de IA estándar de los bots de clientes (gpt-4o-mini o Claude Haiku).
- Nombre y aspecto del personaje (por defecto "Convi").
- Textos legales (AUD Etapa 8, punto 7).

## Estado (actualizar en cada PR)

| # | Paso | Estado | PR | Fecha | Notas |
|---|---|---|---|---|---|
| 1 | AUD 2 — Aislamiento | ✅ en PR #545 | #545 | 2026-10-27 | Filtro de organización explícito en api, worker y `packages/database`. Cierra modo dueño cruzado (§2.1/§7.5) y fallback de número de otro cliente (§2.0 fila 4). Chequeo de rol de BD al arrancar → `dbRoleOk` en `/health/status`. 18 tests nuevos (worker 337/337, api 195/195). Sin migraciones ni cambios de entorno; TuBot sin impacto visible. Pendiente anotado: unique compuesto `(organizationId,id)` para cerrar los `update`/`delete` por id (requiere OK del dueño). |
| 2 | AUD 3 — Confiabilidad 24/7 | pendiente | | | |
| 3 | COP 0 — Camino a bot activo y pagado | pendiente | | | |
| 4 | AUD 4 — Dinero | pendiente | | | |
| 5 | AUD 6 — Marcas y fusibles | pendiente | | | |
| 6 | CRE 1 — Motor de Créditos IA | pendiente | | | |
| 7 | CRE 2 — Catálogo y migración | pendiente | | | |
| 8 | AUD 5 — Auth y permisos | pendiente | | | |
| 9 | AUD 7 — WhatsApp y canales | pendiente | | | |
| 10 | COP 1 — Copiloto que actúa | pendiente | | | |
| 11 | COP 2 — Personaje y experiencia | pendiente | | | |
| 12 | CRE 3 + COP 3 — Transparencia, avisos y pago | pendiente | | | |
| 13 | AUD 8 — IA, frontends y cierre | pendiente | | | |
| 14 | CRE 4 + COP 4 — Medición y calibración | pendiente | | | |
