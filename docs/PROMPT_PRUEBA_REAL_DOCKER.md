# PROMPT DE DESARROLLO — PRUEBA REAL EN DOCKER: probar COMO EL DUEÑO, en navegador, antes de cualquier cosa

**Para el desarrollador (Claude Code en VS Code, con agentes).** Javier volvió a toparse
en producción con un error que nuestras suites daban por cubierto: el Asistente
respondiendo **"No pude responder ahora (Not Found)"**. La causa es conocida (su cuenta
de prueba nació con marca tubot ANTES del fix #506 y el gate la rechaza), pero el
problema de fondo es nuestro: **las pruebas por API no reproducen lo que vive el dueño
en el navegador**. Desde ahora la regla es:

> **Ninguna funcionalidad se da por buena hasta que un navegador real, contra el stack
> Docker, recorre el flujo EXACTO del usuario y lo ve funcionar.** Lo que Javier hace a
> mano en la web, lo hace Playwright en Docker, siempre.

## PARTE 1 — Reproducir y cerrar el caso exacto del pantallazo (primero esto)

1. **Regresión UI del caso real**: test Playwright que reproduce el camino de Javier
   tal cual: cuenta con `organization.brand = "tubot"` viendo el panel conversia-web →
   /canales → error de popup → botón "Pedir ayuda al asistente" → HOY: burbuja con
   "(Not Found)". Este test debe FALLAR antes del fix y quedar en verde después.
2. **Fix de UX de elegibilidad**: si `GET /assistant/context` devuelve 404/403, la
   burbuja NO se muestra (y el botón "Pedir ayuda" cae a un enlace de soporte). Jamás
   un "(Not Found)" crudo al dueño. Mensajes de error del asistente siempre en
   lenguaje humano y accionables.
3. **Reparación de datos en producción**: script `tools/ops/reparar-marca.mjs` que
   liste las orgs `brand='tubot'` nacidas desde el funnel Conversia (heurística:
   `settings.vertical` presente, o evento funnel `registered` con vertical, o email en
   dominios de prueba conocidos) y, con flag `--apply`, corrija marca + plan de prueba
   V2 + regalo de 30 si no lo tiene. Dry-run por defecto; registro en audit_log. Lo
   corre Javier/tú contra prod vía `railway run` (documentado en el runbook §10).
   Las cuentas de prueba de Javier deben quedar funcionando SIN que él cree otra.
4. **Verificación en producción post-deploy**: con la cuenta QA del flujo documentado
   (qa+<fecha>@…), confirmar EN PROD: burbuja visible, pregunta de ayuda del popup →
   respuesta útil del asistente (no genérica), y en una cuenta tubot simulada que la
   burbuja no aparece. Agregar estos checks a `tools/sim/smoke-prod.mjs`.

## PARTE 2 — LA SUITE "COMO EL DUEÑO" (browser-real en Docker, la prueba robusta)

Construye `apps/conversia-web/e2e/como-el-dueno/` — Playwright contra el stack Docker
completo (compose + seed + golive), **con el navegador haciendo exactamente lo que
haría Javier**, en móvil y desktop:

**Jornada A — "Nazco y quedo operando" (por CADA uno de los 14 rubros, parametrizado):**
registro desde el dominio apex (Origin `conversia.cl`) → panel con 30/30 → el asistente
saluda y dice qué falta → cargo 2 servicios con precios POR EL CHAT del asistente
(confirmación incluida; verificar en la UI de servicios que quedaron) → conecto el canal
(en Docker: canal MOCK vía el flujo de UI de /canales con el popup mockeado) → un
"cliente" me escribe (webhook mock) → veo la conversación en la Bandeja → el bot
respondió → respondo yo a mano desde la Bandeja → el contador de créditos bajó como
corresponde en /cobros.

**Jornada B — "Me equivoco y el sistema me cuida":** popup bloqueado (mock del
beforeunload/popup) → banner con Reintentar → "Pedir ayuda al asistente" → la respuesta
menciona ESPECÍFICAMENTE las ventanas emergentes; pago rechazado (mock) → mensaje claro;
API caída a mitad de navegación (apagar el contenedor api 10 s) → la UI muestra error
accionable y se recupera sola al volver, sin pantallas blancas ni "(Not Found)".

**Jornada C — "Agoto y recargo":** consumir el saldo hasta la gracia (tráfico mock) →
los avisos aparecen en la campana y el panel → el asistente responde "¿cuánto me
queda?" con el número real → recarga por checkout mock → el saldo sube EN LA UI.

**Jornada D — "Soy TuBot":** cuenta tubot en SU panel (apps/web) intacta: sin burbuja
Conversia, sin packs de conversación, sus precios de siempre. Y una cuenta tubot que
por error entre a conversia-web: sin burbuja, sin errores crudos.

**Reglas de la suite:**
- Corre contra Docker con la MISMA config de producción endurecida (rol conversia_app,
  NODE_ENV que active los guards donde aplique).
- Asserts sobre lo que SE VE (texto en pantalla, estados, contadores), no solo sobre
  respuestas HTTP. Consola del navegador limpia en cada paso (fallo si hay errores).
- Cada bug que Javier reporte en adelante entra PRIMERO como test de esta suite
  (rojo), después se arregla (verde). Sin excepciones.
- La suite completa corre en CI (job nightly si es muy lenta; el subconjunto crítico
  A+B en cada PR).

## PARTE 3 — Cierre

1. Corre TODO: esta suite nueva + sim250 + Playwright M5 + smoke-prod tras el deploy.
2. Entregable `docs/PRUEBA_REAL_RESULTADOS.md`: tabla de jornadas × dispositivos ×
   resultado, el antes/después del caso del pantallazo, la salida del script de
   reparación de marcas (cuántas orgs corrigió en prod), y veredicto.
3. PRs por bloque con evidencia (videos/trazas de Playwright adjuntas o enlazadas).

## Reglas duras

TuBot intacto · nada destructivo en producción (el script de reparación: dry-run por
defecto, --apply solo con la lista revisada) · prohibido marcar verde algo que el
navegador no haya visto funcionar · prohibido bajar la vara: se arregla el producto.
