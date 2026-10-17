# RUNBOOK GO-LIVE V2 — pasos post-merge en PRODUCCIÓN (17-oct-2026)

El código ya se despliega solo al mergear a `main` (Railway autodeploy). Estos pasos
tocan la BD/las variables de producción y se corren UNA vez, en este orden, desde la
raíz del repo. `railway run` inyecta las variables del servicio en el comando **sin
mostrarlas** (requiere `railway link` al proyecto `conversia`, ya hecho en esta máquina).

> Nota: el servicio Postgres de Railway expone `DATABASE_PUBLIC_URL` (host público).
> Si el nombre difiere, verifica con `railway variables --service Postgres` (tabla
> enmascarada) y ajusta la variable en los comandos.

## 0. URGENTE — variable de build del panel (hallazgo prod 17-oct)

El bundle desplegado de `conversia-web` se construyó **sin `NEXT_PUBLIC_API_URL`** y
apunta a localhost: el panel/generador quedaba "Cargando…" para cualquier visitante.
El PR #488 agrega una red de seguridad de runtime (el sitio en *.conversia.cl cae a la
API pública), pero la config correcta es:

Railway → servicio `conversia-web` → Variables:
- `NEXT_PUBLIC_API_URL = https://${{api.RAILWAY_PUBLIC_DOMAIN}}`
(guardar → redeploy automático; es build-arg, el valor queda inlined en el bundle).

## 0b. CLOUDFLARE — purga + regla de caché (hallazgo prod 17-oct, "sigo viendo lo viejo")

Las páginas HTML salían con `s-maxage=31536000` (1 año) y Cloudflare servía versiones
VIEJAS después de cada deploy (así se vio dos veces el "Cargando rubros…" ya corregido).
El código ya baja el TTL del HTML a 60 s, pero además, en el dashboard de Cloudflare
(dominio conversia.cl):

1. **Ahora**: Caching → Configuration → **Purge Everything** (una vez, limpia lo viejo).
2. **Permanente**: Caching → Cache Rules → nueva regla "Bypass HTML":
   - Cuando: `Hostname contiene conversia.cl` AND `URI Path no empieza con /_next/static`
   - Entonces: **Bypass cache**.
   (Los assets /_next/static siguen cacheados: van versionados por hash.)

Mientras no se purgue, un visitante con el POP "sucio" puede seguir viendo lo anterior;
tras la purga + regla, cada deploy se ve al instante.

## 1. HARDENING CRÍTICO — activar RLS en producción (rol `conversia_app`)

Hoy `api` y `worker` conectan como `postgres` (superusuario → RLS NO aplica; la
auditoría de la sim encontró que varias lecturas confían en RLS). El rol
`conversia_app` ya existe con contraseña fuerte (DEPLOYMENT.md, hardening #3) y TODA
la simulación de 250 clientes corrió con esta configuración exacta — está validada.

En Railway → servicio `api` y servicio `worker` → Variables:
- `DATABASE_URL` = la misma URL pero con usuario/clave de `conversia_app`.
- `DIRECT_DATABASE_URL` = la URL admin actual (postgres) — la usan register/billing/webhooks.
(Ambos servicios redeploys automáticos al guardar.)

## 2. Setup idempotente de BD (RLS/FKs/grants al día)

```bash
railway run --service Postgres -- bash -lc 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm --filter @conversia/database run db:setup'
```

## 3. Seed del catálogo (14 rubros + planes V2 inactivos + packs; todo idempotente)

```bash
railway run --service Postgres -- bash -lc 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm --filter @conversia/database run db:seed'
```

## 4. Encender V2 (selfServe + plan base + packs de conversación)

```bash
railway run --service Postgres -- bash -lc 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_DATABASE_URL="$DATABASE_PUBLIC_URL" node packages/database/scripts/v2-golive.mjs'
```

## 5. Verificar la tarifa de servicio (sin esto, el excedente del free tier cobra $0)

```bash
railway run --service Postgres -- bash -lc 'psql "$DATABASE_PUBLIC_URL" -At -c "SELECT value FROM platform_settings WHERE key='"'"'whatsappRateSchedule'"'"';"'
```

Si sale vacío, sembrarla (tarifa servicio CL/CO oct-2026; ajustar si Meta publica otra):

```bash
railway run --service Postgres -- bash -lc 'psql "$DATABASE_PUBLIC_URL" -c "INSERT INTO platform_settings (key,value,updated_at) VALUES ('"'"'whatsappRateSchedule'"'"','"'"'{\"CL\":{\"service\":[{\"effectiveFrom\":\"2026-10-01T00:00:00Z\",\"rateUsd\":0.02}]},\"CO\":{\"service\":[{\"effectiveFrom\":\"2026-10-01T00:00:00Z\",\"rateUsd\":0.018}]}}'"'"',now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();"'
```

## 6. Chequeo de variables de seguridad (api y worker)

- `WHATSAPP_PROVIDER=meta` (con el fix de esta noche, la ruta mock del webhook queda
  CERRADA en producción con proveedor real — pero igual confírmalo).
- `META_APP_SECRET` presente (con el fix, sin él el webhook real queda fail-closed).
- `MOCK_INBOUND_TOKEN` distinto del default (defensa extra; ya no alcanza para inyectar).
- `NODE_ENV=production` en ambos servicios (activa los guards de mock-confirm y webhook).

## 7. Humo post-deploy (2 minutos)

1. Registrar una cuenta de prueba en app.conversia.cl con rubro `gimnasio` →
   debe nacer con plan de prueba, 30 conversaciones de regalo y el paquete instalado.
2. `GET /onboarding` (o abrir el panel) → checklist de **7 pasos** incluyendo
   "Cargar tu método de pago".
3. `POST /billing/mock-confirm` desde esa cuenta → debe responder **400**
   ("pasarela real configurada") — si responde 200, revisar paso 6.
4. Borrar la cuenta de prueba desde el super admin.

## Recordatorios

- Redis de producción ≥ 6.2 (BullMQ lo advierte con 5.x).
- Antiabuso de registro ~10/IP por ventana: subirlo si la campaña comparte IPs (CGNAT).
- Los tenants demo del seed (Digital Dent / Clínica Demo) tienen canal MOCK: con el fix
  del webhook ya no son inyectables en prod; aún así no publicar sus slugs.
