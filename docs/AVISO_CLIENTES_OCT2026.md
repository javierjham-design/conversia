# Aviso a clientes — cobro de WhatsApp de servicio (oct 2026)

**Borradores LISTOS, NO ENVIADOS.** El disparo es `scripts/send-oct2026-notice.mjs`
(dry-run por defecto; `--confirm SI-ENVIAR` para enviar) → evento `announcement.oct2026`
(oculto, una vez por org ACTIVE). **No ejecutar sin que el dueño lo pida.**

El cobro **ya rige** (desde el 2026-10-01): los textos están en modo presente, sin
ventana transitoria. La acción del cliente (si aplica) es **a la brevedad**.

---

## Correo

**Asunto:** Cambio de WhatsApp desde el 1 de octubre: qué significa para tu cuenta

**Cuerpo:**

Hola {nombre},

Te escribimos para contarte un cambio de WhatsApp (Meta) que ya está vigente y cómo lo
manejamos en TuBot para que tu operación no se vea afectada.

**1. Qué cambia.** Desde el 1 de octubre de 2026, WhatsApp cobra las respuestas dentro
de la ventana de 24 h (antes eran gratis). Cada cuenta de WhatsApp tiene 1.000 de esas
respuestas gratis al mes; sobre ese número, cada respuesta tiene un costo.

**2. Qué hicimos en TuBot.** Tu plan ahora incluye un **cupo mensual de conversaciones**:
la unidad simple con la que medimos ese consumo. Te avisamos automáticamente **al 80 %**
y **al 100 %** de tu cupo, y **por defecto no cortamos** tus respuestas — te contactamos
para ajustar el plan si hace falta. Nada de letra chica ni sorpresas en la cuenta.

**3. Qué tienes que hacer tú.**

> **[VARIANTE (a) — cliente con WABA propia · PENDIENTE DE DECISIÓN A3/D3]**
> Tu número de WhatsApp está a tu nombre en Meta. Para que las respuestas sobre las 1.000
> gratis no se detengan, **registra un medio de pago en tu cuenta de Meta Business a la
> brevedad**: entra a business.facebook.com → Configuración del negocio → Facturación y
> pagos → Agregar medio de pago, y asócialo a tu cuenta de WhatsApp. Si necesitas ayuda,
> respóndenos este correo.

> **[VARIANTE (b) — OBO / número administrado por TuBot · PENDIENTE DE DECISIÓN A3/D3]**
> Nada de tu parte: **nosotros administramos el pago a Meta** por tu número. El cupo de
> conversaciones de tu plan ya cubre este cambio.

Cualquier duda, aquí estamos.
El equipo de TuBot

> **Nota interna:** elegir UNA variante según la decisión **A3/D3** del dueño (tarjeta del
> cliente vs. OBO). Hasta que se decida, ambas quedan marcadas y el correo NO se envía.

---

## Aviso in-app (evento `announcement.oct2026`)

> WhatsApp cobra las respuestas dentro de 24 h desde el 1 de octubre. Tu plan ya incluye
> un cupo mensual de conversaciones y avisos al 80 %. Revisa los detalles en Plan y
> facturación.

(Enlace: `/billing`.)
