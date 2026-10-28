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
| 2 | AUD 3 — Confiabilidad 24/7 | ✅ en PR #546 | #546 | 2026-10-27 | Cerrojo por conversación, rescate del turno en el camino duplicado (bot mudo), claim anti doble-envío, tope de tokens con frase de respaldo en vez de silencio, recuperación del scheduler y apagado ordenado de los 14 workers. Retención de jobs en las 21 colas + `tools/ops/clean-queues.mjs`. 18 tests (worker 355/355, api 195/195). Migraciones anotadas: `SENDING` en MessageStatus y `scheduled_jobs.updated_at`. |
| 3 | COP 0 — Camino a bot activo y pagado | ✅ en PR #550 | #550 | 2026-10-27 | Checklist ÚNICO (reemplaza los dos que había) con enlaces que existen + test que recorre las rutas reales · `POST /agents/:id/qa-publish` para que el cliente publique su bot (antes quedaba en borrador para siempre) · asignación automática e idempotente del agente al canal (antes el canal quedaba sin nadie respondiendo) · cobro en conversia-web con retornos por marca (antes iban a /billing = 404 en Conversia) y tarjeta con Flow en /cobros · el borrador de /crear ya no se pierde (web + texto del sitio se anexan al prompt). ~90 tests (api 272/272, worker 337/337, conversia-web 12/12) + e2e jornada G. Sin migraciones; TuBot congelado por test. PENDIENTES: (1) `/ajustes` no tiene formulario de nombre/rubro/dirección/horario, así que el paso "datos del negocio" aún no se puede completar desde el panel (lo cierra COP 1). (2) ⚠ BUG CONOCIDO SIN RESOLVER: al volver de la pasarela a `/cobros?pago=ok` el aviso de confirmación nunca aparece; el caso de la jornada G quedó en `test.fixme` (deshabilitado, NO borrado, con el detalle dentro del test). Hay que reproducirlo con el sim en Docker. El punto 4 de COP 0 NO se considera cerrado. |
| 4 | AUD 4 — Dinero | ✅ en PR #548 | #548 | 2026-10-27 | Flow es el método ACTIVO (Lemon corregido pero inerte). Nunca el proveedor falso en producción, orden de cobro corregido, recarga de la bolsa ATÓMICA y compartida, packs idempotentes, y débito FAIL-CLOSED con su asiento en la misma transacción (antes se podía cobrar dos veces el mismo mensaje). Decisión del dueño: las recargas manuales del super admin NO recortan saldo comprado; el recorte queda solo en la renovación por pasarela. 6 tests (worker 344/344, api 203/203). |
| 5 | AUD 6 — Marcas y fusibles | ✅ en PR #552 | #552 | 2026-10-27 | El fusible global pasa a ser POR MARCA (antes un pico de Conversia dejaba a TuBot sin poder enviar, y al revés) y `/health/fuse` reporta las dos. Planes por marca. Las escrituras de configuración GLOBAL quedan reservadas a TuBot, y las acciones por `id` que cruzaban marcas —editar/borrar paquetes, cerrar tickets, dar por pagada una factura, editar prospectos— ahora validan a quién pertenece la fila. Doble guarda del cobro: para debitar hace falta marca conversia **Y** feature del plan, de modo que un plan de TuBot mal marcado no le cobre a sus clientes. 42 tests nuevos, incluidos un "TuBot sigue igual" y un escáner que falla si una ruta de escritura nueva no decide su alcance por marca. api 310/310, worker 376/376. Sin migraciones. REQUIERE TU OK (no bloquea): cupones y prospectos quedan de TuBot porque esas tablas no tienen columna `brand`; dárselos a Conversia es una de las migraciones diferidas. |
| 6 | CRE 1 — Motor de Créditos IA | pendiente | | | |
| 7 | CRE 2 — Catálogo y migración | pendiente | | | |
| 8 | AUD 5 — Auth y permisos | ✅ en PR #551 | #551 | 2026-10-27 | Los 10 puntos de la etapa. Agujeros cerrados: entrar con Google saltaba el 2.º factor; una sesión robada podía reenrolar el MFA sin saber la contraseña; la IP se tomaba de `X-Forwarded-For` (falsificable) y con eso se saltaba la allowlist del super admin; la exención de MFA del panel se activaba con `?x=/platform/auth/`; nueve acciones de escritura de la Bandeja no pedían permiso; desactivar a alguien no cortaba su sesión; y el link de invitación estaba ROTO (el frontend lo llama sin Bearer y el middleware lo rechazaba). Nuevo: límite por IP en el login con respaldo en memoria si Redis cae, y bitácora de todo lo que hace una sesión de impersonación. 60 tests nuevos + 91 casos en `platform-policy.spec.ts`; api 279/279, worker 362/362. Sin migraciones. REQUIERE TU OK: la etapa saca del rol OPERADOR las acciones por-org de dinero y de apropiación de cuenta (incluida `impersonate`), que F10 daba por permitidas. |
| 9 | AUD 7 — WhatsApp y canales | ✅ en PR #553 | #553 | 2026-10-27 | Lo más grave que cierra: el id de la WABA y del número entraban por el formulario y se guardaban sin comprobar, así que una cuenta podía declarar el número de OTRA y quedar recibiendo y enviando como ella — ahora Meta lo confirma con el token del propio cliente, en los 4 caminos de entrada. Además: el token global de la plataforma sale de los endpoints de tenant; la ventana de 24 h cerrada y los números que no reciben dejan de reintentarse y explican qué hacer; los rate limit de Meta esperan en vez de insistir, con tope de ritmo en la cola; el webhook de Meta CRM ya no acepta cuerpos sin firma en producción; el eco del dueño en coexistencia calla al bot 2 h (antes el cliente recibía dos respuestas); y los estados de mensaje ya no van hacia atrás. 32 tests; api 296/296, worker 378/378. Sin migraciones. REQUIERE TU DECISIÓN: el token global en el ENVÍO quedó visible pero no cortado, a la espera de que confirmes que nadie depende de él (`WA_GLOBAL_TOKEN_FALLBACK=block`). |
| 10 | COP 1 — Copiloto que actúa | pendiente | | | |
| 11 | COP 2 — Personaje y experiencia | pendiente | | | |
| 12 | CRE 3 + COP 3 — Transparencia, avisos y pago | pendiente | | | |
| 13 | AUD 8 — IA, frontends y cierre | pendiente | | | |
| 14 | CRE 4 + COP 4 — Medición y calibración | pendiente | | | |
