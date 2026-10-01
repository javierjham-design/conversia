# Copy del cambio de cobro de WhatsApp (oct 2026) — inventario y estado

Inventario de la auditoría del copy que afirmaba que responder dentro de 24 h era gratis.
Desde el 2026-10-01 eso ya no es cierto (se mide en E2, se controla por cupo en E3). Este
documento refleja el estado tras E5.

## 1. Cambios aplicados (E5)

| # | Archivo | Antes → Después | Estado |
|---|---------|-----------------|--------|
| 1 | `packages/notifications/src/catalog.ts` (`wallet.empty`) | "…Puedes seguir respondiendo dentro de las 24 h sin costo." → "…Las respuestas dentro de las 24 h no usan esta bolsa: descuentan de tu cupo mensual de conversaciones." | ✅ |
| 2 | `apps/web/.../billing/wallet-card.tsx` | "Responder dentro de las 24 h no cuesta." → "Desde el 1 de octubre de 2026, WhatsApp también cobra las respuestas dentro de las 24 h: van contra tu cupo mensual de conversaciones, no contra esta bolsa." | ✅ |
| 3 | `apps/worker/src/messaging-guard.ts` (`plan_no_templates`) | "…dentro de las 24 h sin costo." → "…dentro de las 24 h con tu cupo de conversaciones." | ✅ |
| 4 | `apps/worker/src/messaging-guard.ts` (`no_balance`) | ídem cierre nuevo | ✅ |
| 5 | `apps/worker/src/messaging-guard.ts` (`demo`) | "…responder dentro de las 24 h." → "…responder dentro de las 24 h (con el cupo de conversaciones del modo demo)." | ✅ |
| 6 | `apps/web/.../workflows/[id]/runs/page.tsx` | agrega "Las respuestas dentro de 24 h usan tu cupo de conversaciones." | ✅ |
| 7 | `docs/TUBOT_TENANT.md` (prompt comercial) | "Responder dentro de 24 h es GRATIS. Explícalo simple…" → "Las respuestas dentro de las 24 h descuentan del cupo de conversaciones del plan (eran gratis hasta el 30-09-2026). Si preguntan por precios exactos, deriva…" — **SQL del bot NO regenerado** (seed stale; prompt vivo se publica por API con OK-7) | ✅ (doc) |
| 8 | Docblocks/docs internas | `wallet.ts` y `messaging-guard.ts` (encabezado) corregidos; `PREPAID_WALLET_DESIGN.md` (×2) y `WHATSAPP.md` con nota "[Vigente hasta 2026-09-30…]"; `pricing.ts` ya quedó en pasado en E1 | ✅ |

## 2. Pendientes de OK del dueño (zona `apps/web/src/app/admin` — NO tocada)

| Archivo | Texto | Nota |
|---|---|---|
| `admin/calculator/page.tsx:173` | "servicio dentro de 24 h = gratis" | corregir a "servicio = según cupo de conversaciones" |
| `admin/calculator/page.tsx:239` | "Servicio dentro de 24 h = gratis; «default» = fallback." | ídem |
| `admin/.../messaging-limits` | "las respuestas dentro de 24 h nunca se tocan" | desactualizado (ahora hay gate de servicio) |
| `admin/.../messaging-cap-card` | "solo plantillas (las que cuestan)" | ahora el servicio también cuesta |

**Brecha funcional (auditoría N7):** la calculadora del admin **no expone ni suma la
categoría `service`** en su cálculo de costo. Queda como mejora de F10/consola (fuera de E5).

## 3. Verificados como NO afectados (no "corregir de más")

- Landing / páginas públicas.
- Textos legales.
- Semáforo de ventana de 24 h de la Bandeja (indicador técnico de la ventana, no una
  afirmación de gratuidad).
- `packages/agents/src/tools.ts:540` ("el plan Free no es gratis para siempre") — es sobre
  el trial, no sobre el servicio.

## 4. Barrido de verificación (E5)

`grep -i "sin costo|no cuesta|no cuestan|es gratis|gratis.*24|24 h.*gratis"` sobre
`apps/` y `packages/` (.ts/.tsx): **no queda ninguna afirmación de gratuidad de las 24 h
vigente** fuera de los 4 textos de `admin` listados arriba (pendientes de OK) y de la nota
en pasado de `pricing.ts`.
