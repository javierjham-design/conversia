# Modelo de amenazas — Conversia / TuBot

> Escrito para una realidad concreta: **la mensajería de WhatsApp se paga con
> NUESTRA línea de crédito a Meta**. Un abuso no es un bug estético — es dinero
> saliendo hoy y el cliente pagándonos después (o nunca). Este documento define
> quién puede atacarnos, qué lograría **HOY** con el código actual, y con qué se
> lo impide. El detalle técnico y el plan están en [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).

Fecha: 2026-08-10. Alcance: producción actual (Railway; api + worker + web;
Postgres con RLS; BullMQ). Metodología: revisión de código con criterio de
atacante + verificación de rutas de envío, límites y autenticación.

## Activo que protegemos (en orden de dolor)
1. **Nuestra línea de crédito con Meta** — el gasto de plantillas de todos los
   tenants. Es lo único que puede vaciar la caja sin que nos demos cuenta.
2. Aislamiento entre tenants (datos de un cliente no visibles por otro).
3. Integridad de planes/saldos/facturación.
4. Credenciales y tokens (WABA de cada tenant, pasarela, Meta app secret).
5. El Super Admin (la llave de todo).

## Resumen del riesgo (una línea)
El aislamiento entre tenants, la autenticación y los webhooks están **bien
resueltos**. El hueco grande y estructural es **financiero**: hoy **no existe
tope de gasto de mensajería aplicado en el punto de envío** — ni bolsa prepagada,
ni fusible global, ni bloqueo durante la gracia. La exposición máxima actual es,
en la práctica, **la que Meta permita por límite de mensajería**, no la que el
cliente pagó.

---

## Actores y qué logran HOY

### 1. Tenant legítimo que quiere gastar más de lo que paga
- **Qué logra hoy**: **enviar plantillas sin techo real**. No hay bolsa de saldo
  ni límite de mensajes aplicado antes de enviar (flujos, agentes, bandeja,
  recordatorios del worker). El consumo se **registra después** (webhook de
  estado de Meta), así que el gasto ya ocurrió cuando lo contabilizamos. Puede
  armar un flujo que dispare plantillas a toda su base y el costo lo financiamos
  nosotros hasta que llegue la factura de Meta.
- **Qué lo impide hoy**: nada estructural. Solo el **límite de mensajería de
  Meta por número** (tier 250 / 1K / 10K / 100K conversaciones iniciadas por
  negocio cada 24 h) pone un techo de *velocidad*, no de plata. → **CRÍTICO**.
- **Qué debería impedirlo**: bolsa prepagada con débito atómico previo (Eje 1.2),
  tope duro por tenant en el punto de envío y fusible global (Eje 1.4).

### 2. Alguien que se registra a la demo para quemar mensajes gratis (y repetirlo)
- **Qué logra hoy**: crear una organización (registro abierto, solo rate-limit
  por IP; **sin verificación de correo ni de teléfono**) y, como org en TRIAL,
  **enviar plantillas igual que un tenant pagado** (el envío no distingue TRIAL).
  Puede repetir con otro correo/IP porque **no hay dedup de registros** (dominio,
  teléfono, RUT, huella). El techo por identidad nueva es solo el tier inicial de
  Meta (~250 conv./24 h). → **CRÍTICO** (abuso repetible = sangría continua).
- **Qué lo impide hoy**: rate-limit de registro por IP (débil: se evade con otra
  IP) y el tier inicial de Meta. Nada más.
- **Qué debería impedirlo**: demo sin envío de plantillas (o cupo simbólico 5–10),
  expiración automática, y antiabuso de registro (correo+teléfono verificados,
  una demo por RUT/número, dedup, bloqueo manual) (Eje 1.3).

### 3. Tenant que se va y deja la WABA colgada de nuestra línea de crédito
- **Qué logra hoy**: irse sin que nadie revoque la compartición de línea de
  crédito ni los permisos sobre su WABA. **No hay chequeo periódico** que alerte
  "esta WABA sigue asociada a nuestro crédito tras la baja". Puede seguir
  facturándonos por meses en silencio (el agujero silencioso del Eje 1.6).
  Nota: al **eliminar el canal** en el panel sí se borran número/WABA locales
  (implementado), pero eso no toca la **relación de crédito del lado de Meta**.
- **Qué lo impide hoy**: la suspensión por impago corta el panel, pero **no** la
  facturación de Meta si la WABA sigue enlazada a nuestra línea. → **ALTO**.
- **Qué debería impedirlo**: protocolo de desvinculación ejecutable + alerta de
  WABAs huérfanas sobre nuestro crédito (Eje 1.6).

### 4. Usuario operativo de un tenant que quiere datos/acciones de otro tenant
- **Qué logra hoy**: **nada cross-tenant**. Toda tabla con `organization_id`
  tiene **RLS** (política `tenant_isolation`, rol `conversia_app` sin BYPASSRLS);
  el `organization_id` sale **siempre del JWT/servidor**, nunca del request; hay
  un job de CI (`tenant-isolation`) que lo verifica en cada push. Cambiar ids en
  la URL no expone datos ajenos.
- **Qué lo impide**: RLS + contexto por token + CI. **Bien resuelto.**
- Escalada de rol: invitar o cambiar roles exige permiso `users:write` (un
  operador no lo tiene) y los dueños están protegidos (`assertCanManage`). **OK.**

### 5. Externo sin cuenta
- **Qué logra hoy**: poco. API detrás de auth (JWT HS256 con issuer/audience
  fijados), CORS acotado a `WEB_URL`, helmet + CSP + HSTS, rate-limit en login/
  registro, webhooks con firma verificada. Login no enumera usuarios.
- **Qué lo impide**: autenticación + cabeceras + firmas. **Bien resuelto**, con
  matices de rate-limit fino (ver auditoría).

### 6. Alguien con un token o credencial filtrada
- **Qué logra hoy**: si filtra un **JWT de tenant**, opera como ese usuario
  **hasta 12 h** (vida del token) — **no hay revocación**: cambiar la contraseña
  o bajar el rol **no invalida** las sesiones activas (el `jti` existe pero no hay
  denylist). Si filtra un **token de WABA**, está **cifrado en reposo**
  (`integration_credentials`) y la API no lo devuelve entero; el riesgo real es
  que quien tenga acceso al secreto de cifrado o a la BD lo descifre. → **MEDIO**.
- **Qué lo impide hoy**: expiración de 12 h, cifrado en reposo, la API no expone
  secretos completos, `appsecret_proof` en llamadas a Graph.
- **Qué debería mejorarlo**: denylist de `jti` / versión de token para revocar al
  cambiar clave o rol (Eje 3.3).

### 7. Empleado nuestro con acceso al Super Admin
- **Qué logra hoy**: mucho — es la llave del negocio. Puede impersonar tenants,
  cambiar planes, tocar credenciales de pasarela (cifradas), y, por diseño de
  Postgres, el rol administrativo **podría** borrar/editar registros incluidos
  `audit_logs` si existiera un endpoint para ello (hoy **no existe** ninguno, pero
  la inmutabilidad depende de "no hay código", no del motor). El acceso exige
  **MFA obligatorio** (implementado) pero **sin restricción de IP por defecto**.
- **Qué lo impide hoy**: MFA obligatorio en `/platform/*`, sesión revocable en
  Redis, `audit_logs` que la app nunca borra, credenciales cifradas.
- **Qué debería mejorarlo**: inmutabilidad de `audit_logs` a nivel de BD (revocar
  UPDATE/DELETE), allowlist de IP para el Super Admin, y registro de toda acción
  sensible (Eje 2.4 / 3.10).

---

## Mapa rápido actor × control (HOY)

| Actor | Lo detiene hoy | Hueco |
|---|---|---|
| Tenant que sobre-gasta | — (solo tier de Meta) | **Sin bolsa/tope de envío** (CRÍTICO) |
| Demo farmer | rate-limit IP + tier Meta | **Sin verificación ni dedup; demo envía** (CRÍTICO) |
| Tenant que se va | suspensión de panel | **WABA sigue en nuestro crédito** (ALTO) |
| Operativo cross-tenant | RLS + contexto + CI | — (bien) |
| Externo | auth + CSP + firmas | rate-limit fino (bajo) |
| Token filtrado | 12 h + cifrado | **Sin revocación de sesión** (MEDIO) |
| Empleado Super Admin | MFA + Redis | **audit mutable a nivel BD; sin IP allowlist** (MEDIO) |

La conclusión operativa: **antes del primer cliente pagando**, cerrar el eje
financiero (bolsa prepagada + fusible + demo sin envío + gracia sin plantillas +
desvinculación). El resto de la superficie (aislamiento, auth, webhooks) ya está
en buena forma y solo necesita endurecimientos puntuales.
