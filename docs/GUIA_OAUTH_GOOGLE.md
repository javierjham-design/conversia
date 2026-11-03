# Guía: app OAuth de Google para Conversia (Calendar + Sheets)

Esta guía crea **una sola app OAuth a nivel plataforma** (la haces una vez tú,
como operador de TuBot/Conversia). Después, **cada tenant** conecta su propia
cuenta de Google desde *Integraciones → Google Calendar / Sheets* con un clic;
sus tokens quedan cifrados por organización.

> Mientras las variables de entorno no estén cargadas, las tarjetas de Google
> aparecen como **«Requiere configuración»** y el drawer lo explica. Nada falla.

## 1. Crear el proyecto en Google Cloud

1. Entra a <https://console.cloud.google.com/> con la cuenta de la empresa.
2. Arriba a la izquierda: selector de proyecto → **Nuevo proyecto**.
   - Nombre sugerido: `TuBot Conversia`.
3. Con el proyecto seleccionado, ve a **APIs y servicios → Biblioteca** y
   habilita estas dos APIs (búscalas por nombre y pulsa *Habilitar*):
   - **Google Calendar API**
   - **Google Sheets API**

## 2. Pantalla de consentimiento OAuth

1. **APIs y servicios → Pantalla de consentimiento de OAuth**.
2. Tipo de usuario: **Externo** (los tenants usan sus propias cuentas Google).
3. Completa:
   - Nombre de la app: `TuBot` (es lo que ve el tenant al autorizar).
   - Correo de asistencia y datos de contacto del desarrollador.
   - Dominio autorizado: `tubot.cl`.
4. **Permisos (scopes)** — declara estos tres en la pantalla de consentimiento:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`

   > **Se declaran los tres, pero NO se piden los tres juntos.** Desde la Etapa 0 de la
   > sincronización con Google Calendar, conectar **Calendar** pide solo los dos de
   > calendario y **Sheets** pide `spreadsheets` aparte, con autorización incremental
   > (`include_granted_scopes=true`). Antes se pedían los tres de una: el cliente veía que
   > la app quería entrar a sus planillas para poder agendar, y eso espanta y complica la
   > verificación. Los permisos que el cliente realmente otorga quedan guardados en
   > `integration_connections.config.scopes`; si falta uno, el panel pide reconectar en vez
   > de dejar que Google conteste 403. Ver `packages/config/src/google-oauth.ts`.
5. Usuarios de prueba: agrega tu propio correo para probar antes de publicar.
6. Cuando todo funcione, pulsa **Publicar aplicación** (estado *En producción*).
   Con scopes sensibles Google puede pedir verificación; mientras tanto la app
   funciona para los usuarios de prueba.

## 3. Crear las credenciales (Client ID / Secret)

1. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**.
2. Tipo de aplicación: **Aplicación web**.
3. Nombre: `Conversia API`.
4. **URIs de redirección autorizados** — agrega la URL pública de la API:

   ```
   https://TU-API.up.railway.app/public/oauth/google/callback
   ```

   (En desarrollo agrega también `http://localhost:4000/public/oauth/google/callback`.)
5. Guarda y copia el **ID de cliente** y el **Secreto de cliente**.

## 4. Cargar las variables de entorno

En Railway (servicio de la **API** y también el **worker**) agrega:

```
GOOGLE_OAUTH_CLIENT_ID=<ID de cliente>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<Secreto de cliente>
```

### App propia de Conversia (opcional, recomendado)

Un cliente de Conversia no debería ver "TuBot" en la pantalla de permisos de Google. Para
eso se crea un **segundo proyecto de Google** con su propia pantalla de consentimiento
(nombre de la app `Conversia`, dominio `conversia.cl`) y sus propias credenciales, con el
MISMO URI de redirección, y se cargan en la api y el worker:

```
GOOGLE_OAUTH_CONVERSIA_CLIENT_ID=<ID de cliente>.apps.googleusercontent.com
GOOGLE_OAUTH_CONVERSIA_CLIENT_SECRET=<Secreto de cliente>
```

Reglas:

- Si **no** están cargadas, las orgs de Conversia siguen usando las credenciales de arriba.
  No hay paso previo obligatorio para desplegar.
- Cada conexión guarda con qué app se emitió su token (`config.oauthApp`) y se refresca
  **siempre con esa misma app**. Una conexión creada antes de este cambio no tiene el campo
  y se refresca con las credenciales de siempre: cargar las de Conversia **no** rompe
  ninguna conexión viva.

Redeploy. Listo: las tarjetas **Google Calendar** y **Google Sheets** pasan a
«Disponible» automáticamente.

## 5. Qué habilita esto (por tenant)

| Función | Dónde se usa |
| --- | --- |
| Espejo de citas → Google Calendar | Drawer de Google: elegir calendario + activar espejo. Cada cita creada/actualizada/cancelada en Conversia se refleja; `googleEventId` se guarda en la cita para no duplicar. |
| Añadir fila a Google Sheets | Paso «Añadir fila a Google Sheets» del editor de Workflows (ID de planilla + columnas con variables). |
| Probar conexión | Botón en el drawer: lista los calendarios con permiso de escritura usando el token real (y refresca si venció). |
| **Un calendario por profesional** | Agenda › Configurar (panel de Conversia): `config.calendars[professionalId]`, con el calendario del negocio como respaldo. El servidor valida que el profesional sea de la cuenta y que el calendario esté entre los que puede escribir. |
| **No ofrecer horas ocupadas en Google** | El bot y el panel restan las horas ocupadas de los calendarios marcados `readBusy`. Caché de 90 s compartida; si Google falla, se calcula solo con la agenda nativa. |
| **Traer los cambios hechos en Google** | Sondeo cada 5 min por calendario (`syncToken`). Mover se aplica; **borrar NO cancela**: marca la cita para revisar. Solo marca `conversia`. Ver ADR-13. |
| **Botón en la Agenda** | `Sincronizar con Google Calendar` con 3 estados + asistente de 1 paso + `POST integrations/google/sync-now` (1 vez por minuto). |

## 5.1 Verificación de la app ante Google

Los permisos de Calendar son **sensibles**: para salir del modo de prueba (tope de 100
usuarios) Google pide verificar la app. Lo que hay que tener:

1. **Pantalla de consentimiento completa**: nombre, logo, correo de soporte y el **dominio
   verificado** en Google Search Console con la misma cuenta del proyecto.
2. **Política de privacidad pública** con una sección de uso de datos de Google y la
   declaración de *Limited Use*: `conversia.cl/legal/privacidad` (sección 5, ancla `#google`).
3. **Justificación por cada permiso**, que diga lo mismo que el video.
4. **Video de demostración** de 1-2 min: guion listo en `docs/GUION_VIDEO_GOOGLE.md`.

Mientras la verificación está en curso la app sigue funcionando para los usuarios de prueba,
así que se puede operar con clientes piloto agregándolos a esa lista.

## 6. Notas de seguridad

- El `state` del flujo OAuth va firmado (HMAC con `JWT_SECRET`) y vence a los
  10 minutos: el callback rechaza cualquier retorno manipulado.
- Los tokens del tenant se guardan **cifrados (AES-256-GCM)** en
  `integration_credentials`; nunca se muestran ni viajan al navegador.
- Si Google revoca el acceso (`invalid_grant`), la conexión pasa a estado
  **«Reconectar»**, se avisa por correo (si las alertas están activas) y los
  jobs dejan de reintentar hasta que el tenant vuelva a autorizar.
- Desconectar desde el drawer **revoca el token en Google** además de borrar
  la conexión local.
