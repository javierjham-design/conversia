# Copy pendiente — cambio de precios de WhatsApp (octubre 2026)

Inventario de TODOS los textos visibles que afirman que responder dentro de la
ventana de 24 h es gratis / no cuesta. Con el cambio de precios de WhatsApp de
octubre 2026 esa afirmación deja de ser cierta y hay que actualizarlos EN UNA
SOLA PASADA (junto con la adaptación de precios). NO se cambian antes.

| Archivo | Ubicación | Texto actual |
|---|---|---|
| `apps/web/src/app/(app)/billing/wallet-card.tsx` | Párrafo bajo el título de la tarjeta "Bolsa de mensajes de plantilla" | «…Responder dentro de las 24 h no cuesta.» |
| `apps/web/src/app/(app)/inbox/thread.tsx` | Etiqueta de ventana (`windowLabel`) | «Ventana de 24 h cerrada — solo plantillas aprobadas» — es FACTUAL (regla técnica de Meta), revisar solo si octubre cambia la mecánica de ventana, no solo el precio |

Notas:
- La tarjeta duplicada "Mensajes de plantilla (WhatsApp)" de la antigua página
  /settings/plan («Las respuestas dentro de las 24 h son gratis y no cuentan»)
  se ELIMINÓ en el Bloque 1.3 de la armonización (la bolsa quedó como única
  tarjeta del tema) — un texto menos que corregir en octubre.
- Al hacer el cambio, buscar además en el repo: `gratis`, `no cuesta`,
  `no cuentan`, `24 h` (textos visibles, correos y plantillas de notificación).
