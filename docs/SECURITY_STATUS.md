# Estado de seguridad — Conversia

Actualizado 2026-07-26. **No se declara seguridad absoluta ni cumplimiento certificado.** Este documento clasifica cada control con honestidad.

Leyenda: ✅ implementado y probado · 🟡 implementado (sin prueba automatizada o parcial) · ⛔ pendiente · 🔬 requiere auditoría externa · ➖ no aplica aún.

## Matriz de controles (ASVS L2 base, L3 en componentes críticos)

| Área | Control | Estado | Evidencia |
|------|---------|--------|-----------|
| **Multi-tenancy** | RLS por tabla + `withTenant` | ✅ | `sql/setup.sql`, verificador 19/19, sondeo API 404 |
| | Rol de app sin BYPASSRLS (cliente dual) | ✅ | `packages/database/src/index.ts`, `prisma.service.ts` |
| | Verificador de aislamiento en CI | ✅ | `verify-isolation.ts`, job `tenant-isolation` |
| | RLS en tablas globales (users/platform_admins/plans) | ✅ | `sql/setup.sql` |
| **AuthN** | Password ≥10, bcrypt cost 12 | ✅ | `auth.service.ts`, `auth.controller.ts` |
| | JWT HS256 fijo + iss/aud + jti | ✅ | `auth/jwt.ts`, `test/jwt.spec.ts` (4 pruebas) |
| | Rate limit login (por email) + registro | ✅ | `common/rate-limit.ts`, `test/rate-limit.spec.ts` |
| | Anti-enumeración de usuarios | ✅ | login/registro con mensaje genérico |
| | MFA (obligatorio admin plataforma) | ⛔ | roadmap 30d |
| | Verificación de correo | ⛔ | roadmap 30d |
| | Revocación de sesión / logout global | ⛔ | roadmap 60d (tokenVersion) |
| **AuthZ** | RBAC por permiso `modulo:accion` | 🟡 | `tenancy/permissions.ts`, `hasPermission` |
| | AuthZ a nivel de objeto (RLS + findUnique→404) | ✅ | controladores de conversación/agentes |
| | Separación admin plataforma / tenant | 🟡 | cliente admin aislado; panel admin plataforma pendiente |
| | Impersonación auditada | ➖ | no existe la función aún |
| **APIs** | Validación por esquema (zod) server-side | ✅ | todos los controladores |
| | Límite de tamaño de cuerpo (512kb) | ✅ | `main.ts` |
| | Rate limit por usuario | ✅ | `rate-limit.middleware.ts` |
| | Errores sanitizados (sin stack en prod) | ✅ | `all-exceptions.filter.ts` |
| | Idempotencia (webhooks/mensajes) | 🟡 | dedupe por wamid/leadgen_id; falta Idempotency-Key genérico |
| **Cabeceras** | helmet (API) + CSP/HSTS/X-CTO/frame-ancestors (web) | ✅ | `main.ts`, `next.config.mjs` |
| | CSP sin `unsafe-inline` en scripts | 🟡 | pendiente nonces (roadmap 60d) |
| **Secretos** | Cifrado AES-256-GCM en reposo | ✅ | `common/crypto.ts` |
| | Nunca al frontend / enmascarado en UI | ✅ | integraciones, `SecretField` |
| | Secret scanning en CI (gitleaks bloqueante) | ✅ | `.github/workflows/security.yml`, `.gitleaks.toml` |
| | KMS / envelope encryption / rotación de clave | ⛔ | roadmap 90d |
| **IA (LLM Top 10)** | Kill switch global + por tenant | ✅ | `agent-turn.ts`, endpoint `ai-killswitch` |
| | Tope diario de tokens por org | ✅ | `agent-turn.ts` |
| | Sanitización de variables (inyección indirecta) | ✅ | `sanitize.ts` (5 pruebas) |
| | Separación instrucción/contenido (history=user) | ✅ | orquestador |
| | Tools con permiso por agente, entrada zod | ✅ | `agents/src/tools.ts` |
| | La IA no accede a BD ni ejecuta SQL/shell | ✅ | por diseño (tools validadas) |
| | Clasificar contenido de KB como no-confiable | 🟡 | precios/horarios NO dependen sólo del RAG; falta marca explícita |
| | Capa política datos permitidos/prohibidos a IA | ⛔ | roadmap 60d |
| **Workflows** | Sin `eval`; nodos tipados zod; versionado | ✅ | motor `@conversia/workflows` |
| | `call_api` con SSRF-guard antes de habilitar | 🟡 | nodo no habilitado; guard existe |
| **Webhooks** | Entrantes: firma HMAC obligatoria | ✅ | `channels/signature.ts` |
| | Salientes: HMAC + reintentos + SSRF-guard | ✅ | `worker/webhook-sender.ts`, `test/url-guard.spec.ts` |
| | Anti-replay (timestamp/nonce) | ⛔ | roadmap 60d |
| **Archivos** | Pipeline cuarentena + antimalware | ➖ | no hay carga de archivos aún; construir con la función |
| **Auditoría** | audit_logs de acciones sensibles | ✅ | tablas `audit_logs`, `integration_events` |
| | Logs sin secretos (sanitizados) | ✅ | `platform-events.ts` `sanitize()`, filtro de errores |
| | Logs inmutables / retención separada | ⛔ | roadmap 90d |
| **DevSecOps** | SAST (CodeQL) | ✅ | `security.yml` |
| | SCA (pnpm audit) | 🟡 | informativo (no bloquea por transitivas) |
| | Container scan (Trivy) | ⛔ | roadmap 30d |
| | IaC scan | ➖ | sin IaC (Railway gestionado) |
| | SBOM (CycloneDX) | ✅ | `security.yml` artefacto |
| **Backups/DR** | Backups cifrados automáticos | 🟡 | Railway gestionado (transferido) |
| | Prueba de restauración | ⛔ | roadmap 30d |
| **Monitoreo** | Alertas de seguridad / centro de seguridad | 🟡 | `integration_events` + `system_alerts` (esquema); panel pendiente |
| **DAST** | ZAP contra staging | 🔬 | pendiente entorno staging |
| **Pentest** | Externo independiente | 🔬 | recomendado antes de uso masivo con datos reales |

## Criterios de aceptación (sección 47 del encargo) — estado honesto

Cumplidos y verificados: 1 (aislamiento), 2 (RLS activo+probado), 3 (endpoints sensibles con authZ), 5 parcial (expiración; revocación pendiente), 6 (secretos fuera de frontend/logs), 9 (validación + rate limit), 10 (webhooks firma+idempotencia; replay pendiente), 11 (SSRF salientes), 12–13 (agentes: no cambian de tenant, tools autorizadas), 15 (workflows sin código arbitrario), 16 (tope IA), 17 (kill switch), 18 (audit logs), 19 (logs sanitizados), 24 (SAST), 26–28 (dep scan / SBOM; container scan pendiente), 29 (IDOR/BOLA probado), 30 (prompt injection probado), 32 (IR plan), 33 (registro de riesgos), 35 (pendientes documentados), 36–37 (sistema funciona; lint/typecheck/tests pasan), 38 (evidencias), 39 (se indica lo que requiere auditoría externa), 40 (no se declara seguridad absoluta).

**No cumplidos / pendientes:** 4 (MFA), 7–8 (archivos/antimalware — N/A hoy), 20–21 (backups cifrados verificados + restauración), 22–23 (monitoreo/alertas operativos), 25 (DAST), 31 (prueba EICAR — N/A sin archivos), 14 (RAG cross-tenant — no activo aún), 34 (todos los P0/P1 cerrados — quedan MFA, replay, restauración, política IA).

## Preparación para producción (por área)

| Área | Veredicto |
|------|-----------|
| Aislamiento multi-tenant | **Aprobada** |
| Autenticación básica (password/JWT/rate limit) | **Aprobada con observaciones** (falta MFA) |
| Autorización por objeto | **Aprobada** |
| Gestión de secretos | **Aprobada con observaciones** (falta KMS/rotación) |
| Seguridad de IA | **Aprobada con observaciones** (falta política de datos + clasificación RAG) |
| Webhooks/integraciones | **Aprobada con observaciones** (falta anti-replay, DNS rebinding) |
| Archivos | **No aplica** (construir con controles) |
| Backups y recuperación | **No aprobada** (sin prueba de restauración) |
| Detección y respuesta | **Aprobada con observaciones** (plan hecho; monitoreo operativo pendiente) |
| Cadena de suministro | **Aprobada con observaciones** |
| Conjunto global | **Requiere auditoría externa** antes de uso masivo con datos clínicos reales |
