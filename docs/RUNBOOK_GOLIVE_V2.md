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

## 8. Humo automatizado contra prod (`smoke-prod.mjs`)

Tras cada deploy, correr el humo de solo-lectura (Node 22, sin dependencias):

```
node tools/sim/smoke-prod.mjs
```

Verifica, contra los dominios públicos reales: dominios arriba + TLS, **bundle sin
`localhost`** (regresión del build sin `NEXT_PUBLIC_API_URL`), **CORS por dominio** (apex +
www + app), funnel completo (`/public/verticals` ≥ 14 rubros, 3 packs, planes), headers y
caché del HTML, mismo `buildId` en ambos dominios, enlaces internos y bordes de seguridad
(webhook/mock/API key). Sale con código 1 si algo falla. También corre solo como canario
diario (`.github/workflows/smoke-prod.yml`); **no** corre en PRs (apunta a prod).

### Caché del HTML (regla de borde, NO código)

El HTML debe servirse con `s-maxage` ≤ 300. El código (`conversia-web/next.config.mjs`) ya lo
hace (`s-maxage=60`). Si el humo marca `s-maxage=31536000` en `/`, `/crear`, `/registro` o
`/login`, es una **Cache Rule del borde (Cloudflare/Railway)** que fija Edge TTL de 1 año →
hay que ponerla en *bypass* o TTL ≤ 300 s para no servir versiones viejas tras un deploy.
(El `31536000` del HSTS sí es correcto; no tocarlo.)

### Checklist de variables por servicio

La tabla completa de env esperado por servicio (crítico/opcional) y la verificación de que
`NEXT_PUBLIC_API_URL` esté como **variable de BUILD** en `conversia-web` están en
`docs/QA_PRODUCCION_RESULTADOS.md` §5.

## 9. Conexión simple de WhatsApp (coexistencia + mini-landing)

Variables de Meta para el camino de **coexistencia** (conectar el número que el cliente ya
usa, vía `GET /public/meta-config?mode=coexistence`):

- `META_ES_COEX_FEATURE_TYPE` — default `whatsapp_business_app_onboarding` (el valor viejo
  `coexistence` fue retirado por Meta; NO usarlo).
- `META_ES_COEX_CONFIG_ID_CONVERSIA` — `config_id` del popup de coexistencia para Conversia.
  Si se deja vacío, cae al `config_id` de Embedded Signup de la marca.

En el **App Dashboard de Meta** (app CONVERSIA), suscribir estos campos de webhook del WABA
(además de `messages`), o la coexistencia no entrega los ecos/historial:

- `smb_message_echoes` — lo que el dueño responde a mano desde su app (lo pinta la Bandeja).
- `history`, `smb_app_state_sync` — historial y contactos (opcionales).
- `account_update` — desconexión/reconexión desde la app.

Autorizar los dominios `app.conversia.cl` / `conversia.cl` en la app de Meta (sin esto el
popup no abre). Validar la elegibilidad de **Chile (+56)** y si la UI es QR o código en un
**sandbox** con un número real que corra la app WhatsApp Business.

**Mini-landing** (`conversia.cl/n/<slug>`): la ruta vive en `conversia-web`, así que
`app.conversia.cl/n/<slug>` ya responde. Para servirla en el apex, mapear `conversia.cl/n/*`
al servicio `conversia-web` (DNS/routing). No requiere variables nuevas.

Estado y criterios de aceptación: `docs/CONEXION_SIMPLE_RESULTADOS.md`.

## 10. Reparar orgs mal nacidas con marca `tubot` (bug pre-#506)

Antes del fix #506, registrarse desde `conversia.cl` (apex) creaba la cuenta con marca
**tubot** (catálogo, plan y asistente equivocados; el asistente respondía "(Not Found)"). El
script `tools/ops/reparar-marca.mjs` las detecta y corrige: `brand→conversia`, plan de prueba
`conversia_v2_trial`, `settings.conversia.lifecycle=v2_trial`, **`users.brand→conversia`** (sin
esto el dueño no puede entrar desde conversia-web: el login resuelve por correo+marca), una
suscripción TRIALING (+60 d) y el **regalo de 30 conversaciones** (idempotente). Deja asiento en
`audit_logs` (`organization.brand_repair`). **No toca las orgs TuBot reales** (la heurística
excluye `digital-dent`/`clinica-demo`).

**Siempre primero DRY-RUN** (solo lista, no muta):

```
railway run -s Postgres -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node tools/ops/reparar-marca.mjs'
```

Revisa la lista. Luego `--apply` **solo con la lista revisada** (exige `--ids`/`--emails` o
`--all`):

```
# Subconjunto revisado (recomendado — p. ej. las cuentas qa+ de prueba):
railway run -s Postgres -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node tools/ops/reparar-marca.mjs --apply --ids=org_a,org_b'
# o por correo:  --apply --emails=qa+...@conversia.cl
# o todas las candidatas tras revisar:  --apply --all
```

Reversible (volver a `tubot` el `brand` de org y usuarios si hiciera falta). Es **corrector, no
destructivo**: no borra datos. Verificación post-apply: con la cuenta reparada, login desde
`app.conversia.cl` → `GET /assistant/context` responde **200** (ya no 404) y el saldo muestra
**30** conversaciones. (Probado end-to-end contra el stack Docker; ver
`docs/PRUEBA_REAL_RESULTADOS.md`.)

## Recordatorios

- Redis de producción ≥ 6.2 (BullMQ lo advierte con 5.x).
- Antiabuso de registro ~10/IP por ventana: subirlo si la campaña comparte IPs (CGNAT).
- Los tenants demo del seed (Digital Dent / Clínica Demo) tienen canal MOCK: con el fix
  del webhook ya no son inyectables en prod; aún así no publicar sus slugs.

## 11. Pendientes del App Dashboard de Meta (anotados 18-oct, revisar con calma)

- **Línea de crédito / Configuración de pagos**: el dashboard la pide para "socios de
  soluciones" (Solution Partners). Operamos como TECH PROVIDER: cada cliente paga a
  Meta directo con su medio de pago y la línea compartida normalmente NO aplica.
  Confirmar: si los tenants TuBot ya envían plantillas pagadas sin línea compartida,
  queda confirmado y este punto se cierra.
- **"Create a system user token" / "Números preverificados"** aparecen sin marcar en el
  checklist de Registro insertado: es guía genérica del dashboard, no el estado real
  (el system user token ya existe si la plataforma opera). Revisar que el token vigente
  esté guardado/rotado como corresponde y documentado.
- **Coexistencia**: pendiente de Meta o del formato nuevo post-deprecación v2/v3
  (15-oct-2026). Fuente de verdad: panel WhatsApp → Registro insertado → selectores
  "Funciones" y "Tipo de función" + la URL alojada que generan. Si los selectores no
  ofrecen el onboarding de la app → ticket por Direct Support, tipo
  "Embedded Signup - Coexistence Onboarding".

## 12. Rotación / caída de token de WhatsApp (incidente 19-oct-2026)

**Síntoma:** los ENVÍOS de WhatsApp fallan (Meta error **190 / OAuthException**) aunque los
mensajes entrantes siguen llegando — "todo se ve normal" pero nadie recibe respuestas.
**Gatillo conocido:** una **migración o cambio de titularidad del Business Manager** en Meta
**invalida los tokens** emitidos antes del cambio (fue la causa del incidente). También: revocar
el Usuario del sistema, rotar su token, o que caduque.

**Cómo nos enteramos ahora (ya no es silencioso):**
- Chequeo ACTIVO cada 15 min (worker `whatsapp-token-health.ts`): valida cada token con
  `GET /{phone_number_id}?fields=id` **sin enviar nada** → un 190 levanta la excepción crítica
  `token_invalido` (consola del super admin) + alerta externa (OPS_ALERT_WEBHOOK_URL → correo/push).
- Fail-fast en el envío: el primer 190 marca el canal "error", deja el mensaje FAILED con el motivo
  y deja de martillar a Meta.
- Visibilidad: banner rojo global en `/admin` si el token del Tech Provider cayó; tarjeta "Salud de
  tokens de WhatsApp" en `/admin/alerts`; aviso humano en Canales del tenant; `whatsappTokenOk` en
  `GET /health/status` (y el check `11-wa-token` de `smoke-prod.mjs`).

**Dónde se genera el token** (Usuario del sistema del Tech Provider):
`Meta Business Settings → Usuarios → Usuarios del sistema → (el de la plataforma) → Generar token`,
con los permisos: **`business_management` + `whatsapp_business_management` + `whatsapp_business_messaging`**
(token permanente de sistema). Para un canal de un tenant, su token propio se recarga en
**Canales → Editar** (o "Reautorizar con Meta", que lo renueva por Embedded Signup).

**Qué variable(s) de Railway tocar** (token GLOBAL / Tech Provider):
- `META_ACCESS_TOKEN` en el servicio **api** Y en el servicio **worker** (ambos; el worker es quien
  envía). Pegar el token nuevo y **redeploy** de ambos.
- (Los tokens por-canal de cada tenant viven cifrados en `integration_credentials`, no en env: esos
  se renuevan desde Canales, no aquí.)

**Cómo verificar que quedó bien:**
1. `GET /health/status` → `whatsappTokenOk: true` (o `node tools/sim/smoke-prod.mjs` con
   `MONITOR_TOKEN` → check `11-wa-token` verde).
2. Forzar el chequeo sin esperar 15 min:
   `railway run -s worker -- node apps/worker/dist/token-health-cli.js` → imprime `SNAPSHOT:` con
   `"ok":true`.
3. El banner rojo de `/admin` desaparece; la excepción `token_invalido` se marca **resuelta**
   automáticamente (o revísala en la cola de excepciones).
4. Manda un mensaje de prueba al bot y confirma que responde.

## 13. Estado de las cuentas de WhatsApp de TuBot (auditoría vía MCP oficial, 21-oct-2026)

- **PRODUCTIVA: "Asistente Virtual TuBot"** — número registrado y listo, cuenta suscrita
  a la app (14 campos de webhook, incluidos los 3 de coexistencia), app publicada. NO
  tocar sin plan.
- **DORMIDA: "Asistente Virtual TuBot V2"** — migración de titularidad que quedó a medio
  hacer (origen del incidente de tokens del 19-oct): número "TuBot IA" VERIFICADO pero
  NO registrado, cuenta SIN suscripción de webhooks y SIN método de pago. No eliminar
  (recuperar cuentas/números es difícil); no usar hasta decidir.
- **Si se decide completar la migración a V2** (proyecto planificado, con el dev):
  1) suscribir la cuenta V2 a la app (MCP `whatsapp_biz_subscribe_webhook`),
  2) registrar el número (MCP `whatsapp_biz_register_phone_number`; PIN si tiene 2FA),
  3) método de pago de la V2 (Billing Hub, link en el reporte del MCP),
  4) actualizar los canales de la plataforma al phone_number_id nuevo y verificar
     salud de token + humo completo. Jamás a mano ni a medias: esa mezcla fue la del
     incidente.

## 14. Pool de números PREVERIFICADOS ("número llave en mano", fase 1)

Permite saltar el SMS al conectar un número NUEVO: el registro insertado recibe
`setup.preVerifiedPhone.ids` con un número ya verificado del negocio de la plataforma. Fase 1:
el alta al pool es MANUAL y la asignación a una org también; el código solo lo expone al
launcher si la marca tiene el flag encendido y la org tiene un número asignado.

**Encender la marca** (apagado por defecto): variable de Railway (api y worker)
`META_PREVERIFIED_ENABLED_CONVERSIA=true`. Sin esto, `GET /channels/connection-extras` siempre
devuelve `preVerifiedPhoneId: null` y el flujo es idéntico al de hoy.

**Alta de un número al pool** (como se hizo a mano el 21-oct con el +1 835-277-9428 del business
`1051306350709612`), con el token de sistema del negocio Conversia/TuBot:
1. `POST /{waba_id}/phone_numbers` (o el alta desde WhatsApp Manager) → obtienes el `phone_id`.
2. `POST /{phone_id}/request_code` (método SMS/VOICE) → llega el código.
3. `POST /{phone_id}/verify_code` con el código → el número queda **preverificado**.
4. Insertar la fila en el pool (vía super admin / SQL), estado `free`:
   `INSERT INTO pre_verified_phones (id, brand, meta_phone_id, display_number, business_id, status)
    VALUES (<cuid>, 'conversia', '<phone_id>', '+1 835 277 9428', '1051306350709612', 'free');`

**Asignar un número a una org** (cuando el cliente pide "número nuevo llave en mano"):
`UPDATE pre_verified_phones SET status='assigned', organization_id='<orgId>', assigned_at=now()
 WHERE meta_phone_id='<phone_id>' AND status='free';`
Desde ahí, al abrir /canales esa org recibe el `preVerifiedPhoneId` y el popup de Meta salta el SMS.

> Fase 2 (futura): alta y asignación automáticas del pool desde la consola; por ahora es manual
> y auditado. El flag apagado deja todo el flujo intacto.

## 15. Política de sesión del panel (sesión deslizante + passkeys Fase 2)

Desde el encargo `docs/PROMPT_SESION_LOGOUT.md` (26-oct-2026) el panel de **conversia-web** usa
**sesión deslizante**: access token corto (`JWT_EXPIRES_IN`, 12 h) + **refresh token** opaco de
larga vida en Redis (`JWT_REFRESH_EXPIRES_IN`, 30 d, rotativo y revocable). El cliente ya no
re-loguea cada 12 h; sí tras 30 d de inactividad, al cerrar sesión o al cambiar la contraseña
(que revoca todas sus sesiones). Detalle en `docs/SESION_RESULTADOS.md`.

- **Env (Railway, servicio api):** `JWT_EXPIRES_IN` (default `12h`), `JWT_REFRESH_EXPIRES_IN`
  (default `30d`). Ambas opcionales; con los defaults funciona. Cambiarlas NO requiere migración.
- **Dependencia de Redis:** los refresh viven en Redis (claves `csess:*`), igual que las sesiones
  de super admin (`psess:*`). Si Redis se reinicia, los refresh se pierden → los clientes re-logean
  (molestia menor, no brecha: el access token caduca igual). No hay migración ni tabla nueva.
- **Revocar la sesión de un usuario a mano** (soporte): borrar sus claves de refresh en Redis —
  `DEL` de `csess:user:<userId>` y de cada `csess:<hash>` del set. El access vigente caduca solo.
- **Acciones sensibles:** hoy el cambio de contraseña revoca todas las sesiones. Una compuerta de
  re-auth reciente para `/cobros`/datos de pago queda apuntada (patrón `reauthAt` del super admin).

### Fase 2 — passkeys / WebAuthn (solo diseño, NO implementar aún)
Para que en el celular el cliente entre con Face ID/huella en vez de contraseña:
- Guardar credenciales WebAuthn por usuario (modelo nuevo `webauthn_credentials`: credentialId,
  publicKey, counter, transports, deviceLabel) + endpoints de registro (attestation) y login
  (assertion) con `@simplewebauthn/server`. El RP ID sería `conversia.cl`.
- El login por passkey emite la MISMA sesión (access + refresh) que el login por contraseña → se
  integra sin tocar el flujo de sesión ya construido. Passkey como 2.º factor o como primer factor.
- Priorizar tras validar adopción del panel móvil. No bloquea nada del estado actual.
