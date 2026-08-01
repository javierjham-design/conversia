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
4. **Permisos (scopes)** — agrega exactamente estos tres:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`
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

Redeploy. Listo: las tarjetas **Google Calendar** y **Google Sheets** pasan a
«Disponible» automáticamente.

## 5. Qué habilita esto (por tenant)

| Función | Dónde se usa |
| --- | --- |
| Espejo de citas → Google Calendar | Drawer de Google: elegir calendario + activar espejo. Cada cita creada/actualizada/cancelada en Conversia se refleja; `googleEventId` se guarda en la cita para no duplicar. |
| Añadir fila a Google Sheets | Paso «Añadir fila a Google Sheets» del editor de Workflows (ID de planilla + columnas con variables). |
| Probar conexión | Botón en el drawer: lista los calendarios con permiso de escritura usando el token real (y refresca si venció). |

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
