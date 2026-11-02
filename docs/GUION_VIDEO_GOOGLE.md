# Guion del video de demostración para Google (verificación de OAuth)

**Para qué sirve este documento.** Google exige un video de demostración para aprobar una app
que pide permisos de Calendar. No es un video de marketing: el revisor necesita ver, sin
cortes, **el flujo de consentimiento con el permiso que se pide y qué hace la app con ese
dato**. Si falta cualquiera de esas dos cosas, rechazan y hay que volver a grabar.

- **Duración:** 1 a 2 minutos.
- **Idioma:** español está bien (Google acepta otros idiomas; si rechazan por eso, se agregan
  subtítulos en inglés).
- **Sin cortes** en el tramo del consentimiento: tiene que verse la URL del navegador.
- **Sin datos reales de clientes.** Grabar con la cuenta de prueba de barbería.
- Grabar en 1280×720 o más, con el navegador en una ventana limpia (sin otras pestañas con
  información de otras cuentas).

---

## Antes de grabar

1. Cuenta de prueba de Conversia (rubro barbería) con **dos profesionales** cargados y horario.
2. Un calendario de Google de prueba, compartido con la cuenta que se va a conectar, con
   permiso *"Hacer cambios en eventos"*.
3. Un evento personal creado en ese calendario para **mañana de 15:00 a 16:00**, con un título
   cualquiera (por ejemplo "Dentista").
4. WhatsApp de prueba listo para escribirle al bot.
5. Cerrar la sesión de Google de otras cuentas, para que la pantalla de consentimiento salga
   limpia.

---

## Guion

### 0:00–0:12 · Qué es esto

> Pantalla: la Agenda de Conversia, ya con dos profesionales.

**Locución:** "Conversia es una plataforma chilena donde negocios pequeños —barberías, centros
de estética, consultas— atienden a sus clientes por WhatsApp con un asistente. Las citas se
agendan solas. Les voy a mostrar por qué necesitamos acceso a Google Calendar."

### 0:12–0:35 · El consentimiento (el tramo que el revisor mira con lupa)

> Acción: clic en **"Sincronizar con Google Calendar"**. Se abre la pantalla de Google.
> **Dejar la pantalla de permisos quieta 3 o 4 segundos**, con la URL visible, para que se lea
> el nombre de la app y los permisos pedidos. Después aceptar.

**Locución:** "Pedimos dos permisos de Calendar: ver los calendarios y administrar sus eventos.
Nada más: no pedimos acceso a Gmail, a Drive ni a planillas. Los permisos los otorga el propio
dueño del negocio sobre su cuenta."

### 0:35–0:50 · Elegir el calendario de cada persona

> Acción: en el asistente que aparece, mostrar la fila de cada barbero con su calendario
> sugerido. Apretar **"Activar sincronización"**.

**Locución:** "Cada persona del equipo queda vinculada a su propio calendario. Con eso ya
podemos hacer dos cosas."

### 0:50–1:15 · Para qué usamos el permiso de LECTURA

> Acción: mostrar el evento personal de mañana 15:00–16:00 en Google Calendar. Volver a
> WhatsApp y escribirle al bot: *"quiero una hora mañana con [barbero]"*. El bot ofrece horas y
> **no aparecen las 15:00 ni las 15:30**.

**Locución:** "Leemos las horas ocupadas de los calendarios elegidos para no ofrecerlas. Acá el
dueño tiene algo a las tres de la tarde, así que el asistente ofrece otras horas. Sin este
permiso le daríamos a un cliente una hora en la que el barbero no puede atender."

### 1:15–1:35 · Para qué usamos el permiso de ESCRITURA

> Acción: aceptar una hora por WhatsApp. Cambiar a Google Calendar y mostrar el evento nuevo,
> con el título "{servicio} · {cliente}".

**Locución:** "Y cuando el cliente confirma, la cita aparece en el calendario del barbero. Así
el dueño maneja su agenda desde su teléfono, con la app que ya usa."

### 1:35–1:50 · Cierre: control y privacidad

> Acción: abrir el menú del botón y mostrar **"Desconectar"**.

**Locución:** "El dueño puede desconectar cuando quiera y revocamos el acceso. No usamos estos
datos para publicidad, no los vendemos y no entrenamos modelos con ellos; está declarado en
nuestra política de privacidad, en conversia.cl/legal/privacidad."

---

## Lista de verificación antes de subirlo

- [ ] Se lee el **nombre de la app** en la pantalla de consentimiento.
- [ ] Se leen **los permisos pedidos** (los dos de Calendar, y ningún otro).
- [ ] Se ve la **URL** del navegador en el tramo del consentimiento.
- [ ] Se muestra un uso **real** de cada permiso otorgado (leer → no ofrecer la hora;
      escribir → la cita aparece en el calendario).
- [ ] Se muestra cómo **revocar**.
- [ ] No aparece ningún dato de un cliente real.

## Lo que hay que tener listo además del video

- Política de privacidad pública con la sección de datos de Google: **conversia.cl/legal/privacidad**
  (sección 5, ancla `#google`) — incluye la declaración de *Limited Use*.
- Dominio `conversia.cl` verificado en Google Search Console con la misma cuenta del proyecto.
- Justificación por permiso, en la consola de Google, que diga lo mismo que el video.

Ver `docs/GUIA_OAUTH_GOOGLE.md` para la configuración de la app y las credenciales por marca.
