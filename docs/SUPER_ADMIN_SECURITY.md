# SUPER_ADMIN_SECURITY.md — Seguridad del acceso Super Admin

Diseño de seguridad del panel de plataforma de TuBot.cl. Honesto sobre lo **implementado** vs **pendiente**.
No se declara activa ninguna protección que no lo esté.

---

## 1. Modelo de identidad (IMPLEMENTADO)

Separación **real y server-side** entre plataforma y tenant:

| Capa | Tenant | Super Admin (plataforma) |
|---|---|---|
| Tabla de identidad | `users` + `organization_users` | **`platform_admins`** (separada) |
| Login | `POST /auth/login` | **`POST /platform/auth/login`** |
| JWT audiencia | tenant | **`conversia-platform`** + claim `platform:true` |
| Verificación | `verifyAppToken` (iss+aud) | **`verifyPlatformToken`** (HS256 fijo + iss + aud + claim) |
| Guard | `TenancyMiddleware` | **`PlatformGuard`** en `/platform/*` |
| Contexto RLS | `withTenant` (org_id) | cliente **admin** (cross-tenant, auditado) |
| Token cliente (web) | `localStorage: conversia_token` | `localStorage: conversia_platform_token` |

**Verificado:** token de tenant → `/platform/*` = **401**; token de plataforma → `/agents` = **401**.
**Un usuario de tenant no puede autenticarse en el Super Admin** (no está en `platform_admins`, y su audiencia no coincide). No hay ruta de elevación.

---

## 2. No descubribilidad (Fase A — en curso)

**Implementado ahora:**
- `X-Robots-Tag: noindex, nofollow, noarchive` en `/admin/*` (`apps/web/next.config.mjs`).
- `robots.txt` con `Disallow: /admin`.
- Sin enlaces internos desde el panel de tenant hacia `/admin` (verificado: no hay `href` a `/admin` en el layout de tenant).

**PENDIENTE (perímetro — requiere infra, NO está activo):**
- **Cloudflare Access** delante de `admin.tubot.cl` (o de `/admin`), con allowlist de correos/Zero-Trust, de modo que el origen no sea accesible sin pasar la capa perimetral. Variables previstas: `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`.
- **Subdominio dedicado** `admin.tubot.cl` (apuntado y con Access) — hoy el panel vive en `tubot.cl/admin`.
- **Allowlist de IP** configurable (`SUPER_ADMIN_ALLOWED_IPS`) a nivel de guard como segunda capa.

> Estado honesto: la URL `/admin` es **alcanzable públicamente** (aunque `noindex`). La protección de acceso hoy es: separación de identidad + rate-limit + bcrypt. **MFA y perímetro son pendientes de Fase A/infra** y NO deben marcarse como activos hasta implementarse.

---

## 3. Autenticación reforzada (Fase A — pendiente de implementar)

- **MFA TOTP obligatorio**: campo `totpSecret` (cifrado) + `mfaEnabledAt` en `platform_admins`; enrolamiento con QR (issuer `SUPER_ADMIN_MFA_ISSUER`), verificación de 6 dígitos en login, **códigos de recuperación** de un solo uso (hasheados).
- **Secreto de sesión separado**: `SUPER_ADMIN_SESSION_SECRET` distinto de `JWT_SECRET` para firmar el token de plataforma.
- **Gestión de sesiones**: tabla `platform_admin_sessions` (jti, IP, UA, creada, última actividad, revocada) → sesiones visibles + cierre remoto + expiración por inactividad + expiración absoluta + revocación inmediata (validar jti contra la tabla en el guard).
- **Reautenticación** para acciones críticas (ver §5).
- Cookies HttpOnly/Secure/SameSite si se migra de `localStorage` a cookie de sesión (recomendado).
- Historial de accesos (IP, país, navegador, dispositivo, resultado) + alertas de inicio de sesión.

## 4. Rate limiting y anti-abuso (PARCIAL)

- **Implementado**: rate-limit por email en `/platform/auth/login` (15/15min), bcrypt cost 12, mensajes genéricos (anti-enumeración).
- **Pendiente**: bloqueo temporal tras N fallos, detección de credential stuffing, CAPTCHA adaptativo, alerta de admin sospechoso.

## 5. Reautenticación para acciones críticas (Fase A — pendiente)

Requerir password + TOTP recientes (ventana corta, p.ej. 5 min) para:
cambiar precio · cambiar límites · suspender/eliminar tenant · cambiar plan · otorgar créditos ·
emitir devolución · modificar suscripción · modo soporte · exportar datos · rotar secretos ·
modificar medios de pago · modificar administradores.

Mecanismo: endpoint `POST /platform/auth/step-up` emite un claim `stepUpAt`; el guard de acciones críticas exige `stepUpAt` reciente.

## 6. RBAC de plataforma (Fase A/G — pendiente)

Roles: Owner · Billing Admin · Support Admin · Security Admin · Operations Admin · Read Only.
Tabla `platform_admin_roles` + permisos por acción; el `PlatformGuard` + un decorador `@RequirePlatformPerm('...')` autorizan por acción. **No todo admin tiene todos los permisos.**

## 7. Auditoría (IMPLEMENTADO parcial → ampliar)

Hoy: `audit_logs` con `actorType='platform_admin'` en login y mutaciones de `platform.controller`. Ampliar a: MFA, cambios de precio/límite/plan, suspensión/reactivación, crédito/descuento, factura/pago/reembolso, publicación de planes, impersonación, exportación, cambios de admin/seguridad/integración/feature-flag — con actor, rol, IP, dispositivo, antes/después, motivo, resultado, correlation-id. Auditoría de plataforma **separada** e inmutable (append-only).

## 8. Mapeo a criterios de aceptación (§40 del brief)

| Criterio | Estado |
|---|---|
| Tenant no accede al Super Admin | ✅ (identidad separada, verificado) |
| Digital Dent no ingresa | ✅ (no está en `platform_admins`) |
| Sesiones separadas | ✅ (audiencia + token + storage separados) · ⏳ revocación/gestión pendiente |
| MFA obligatorio | ⏳ Fase A |
| Perímetro | ⏳ Cloudflare Access (infra) — `noindex`/robots ✅ hoy |
| Reautenticación acciones críticas | ⏳ Fase A |
| Auditoría | ✅ base · ⏳ ampliación |

---

## 9. Orden de implementación (Fase A)

1. **noindex/robots** (hoy) ✅
2. `SUPER_ADMIN_SESSION_SECRET` separado + `platform_admin_sessions` (revocación).
3. **MFA TOTP** + códigos de recuperación.
4. Reautenticación (step-up) para acciones críticas.
5. RBAC de plataforma.
6. Allowlist de IP en el guard (2ª capa) + documentar Cloudflare Access.
7. Ampliar auditoría + alertas de seguridad.
