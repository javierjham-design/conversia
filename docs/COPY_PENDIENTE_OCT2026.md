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

---

# Inventario de incoherencias — armonización UI (Bloque 9)

Incoherencias de texto/datos detectadas durante la armonización que **NO se cambiaron**
porque tocan lógica, backend o requieren decisión de producto. Lista de trabajo, no un cambio.

## Requieren backend / preferencia persistida
- **«Primeros pasos» ocultable**: los pasos completados ya se tachan y quedan clicables para
  revisar (B9). **Ocultar/descartar** el bloque una vez completo necesita persistir una
  preferencia por usuario/organización → endpoint nuevo. Pendiente.
- **Orden de campos personalizados**: se define por drag en Configuración → Campos de contacto
  y la ficha lo respeta; falta confirmar que todos los consumidores (ficha, columnas,
  importación) usan el mismo `order` sin desempates locales. Revisar backend de `/contact-fields`.

## Requieren decisión de producto (dato/copia sensible)
- **`superadmin@conversia.local`**: correo de siembra en datos reales; cambiarlo es tocar
  producción → requiere OK explícito del dueño.
- **`X-Conversia-Signature`** y **«Suscripción Conversia»** (zona de plataforma): contrato de
  API y zona prohibida; no se renombran sin coordinación.
- **Etiqueta de etapa inicial «LEAD»**: la UI muestra el nombre configurado de la etapa; donde
  aparezca el código crudo es dato del tenant en `/settings/lifecycle`, no copy de la app.

## Menores (cosméticos, baja prioridad)
- Plurales «(s)» restantes en textos de baja visibilidad («entrega(s) 7d», «evento(s)» en
  tarjetas de integraciones/desarrolladores). El helper `plural()` (B8) ya existe; aplicar al
  tocar esos componentes.

## Ya resuelto en los bloques (referencia)
- Inglés en pantalla, país «CL CL», 404 propia → B8.
- «Rubro» editable en dos páginas → B9: fuente única en «Rubro y personalización»; en
  «Información general» queda de solo lectura con enlace.
- Acciones-en-fila unificadas, color primario único, logos, modo oscuro, reportes → B4–B7.
