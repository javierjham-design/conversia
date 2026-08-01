# Guía: app OAuth de HubSpot para Conversia

Igual que con Google, esto se hace **una sola vez a nivel plataforma**.
Después cada tenant conecta su propio portal de HubSpot desde
*Integraciones → HubSpot* con un clic (tokens cifrados por organización).

> Mientras las variables no estén cargadas, la tarjeta aparece como
> **«Requiere configuración»** y el drawer lo explica.

## 1. Crear la app en HubSpot

1. Entra a <https://developers.hubspot.com/> y crea una **cuenta de
   desarrollador** (gratuita, separada de tu CRM).
2. **Apps → Create app**.
   - Nombre: `TuBot Conversia` (lo que ve el tenant al autorizar).
   - Logo y descripción opcionales.

## 2. Configurar OAuth

En la pestaña **Auth** de la app:

1. **Redirect URLs** — agrega la URL pública de la API:

   ```
   https://TU-API.up.railway.app/public/oauth/hubspot/callback
   ```

   (En desarrollo agrega también `http://localhost:4000/public/oauth/hubspot/callback`.)
2. **Scopes** — agrega exactamente estos dos (los que pide Conversia):
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
3. Guarda y copia el **Client ID** y el **Client secret**.

## 3. Cargar las variables de entorno

En Railway (servicio **API** y **worker**):

```
HUBSPOT_CLIENT_ID=<Client ID>
HUBSPOT_CLIENT_SECRET=<Client secret>
```

Redeploy. La tarjeta **HubSpot** pasa a «Disponible».

## 4. Qué habilita esto (por tenant)

| Función | Detalle |
| --- | --- |
| Sync automático | Cada contacto nuevo o editado en Conversia (WhatsApp, Lead Ads, Cláriva, workflows) se refleja en HubSpot. |
| Sin duplicados | Antes de crear se busca por teléfono y email; el id de HubSpot se guarda en el contacto (`meta.hubspotContactId`). El 409 de email existente también se resuelve sin duplicar. |
| Mapeo de campos | El tenant elige qué propiedad de HubSpot recibe cada campo (por defecto firstname/lastname/email/phone; admite propiedades personalizadas). |
| Backfill | Botón «Sincronizar contactos existentes»: encola todos los contactos con teléfono o email, escalonados 200 ms para respetar los límites de HubSpot. |
| Probar conexión | Introspección del token: muestra el portal (hub) y el usuario conectados. |

## 5. Notas de seguridad y operación

- Tokens del tenant cifrados AES-256-GCM en `integration_credentials`;
  refresh automático (los access tokens de HubSpot duran 30 min).
- `invalid_grant` → estado **«Reconectar»** + aviso por correo; los jobs
  dejan de reintentar hasta reautorizar.
- Cada registro sincronizado deja un evento en la actividad de
  integraciones (`hubspot.synced` / `hubspot.error`).
- La sincronización es **unidireccional** (Conversia → HubSpot): nada de lo
  que cambies en HubSpot pisa datos de Conversia.
