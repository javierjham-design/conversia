# Seguridad

> **Documentos de seguridad**: [SECURITY_STATUS.md](SECURITY_STATUS.md) (matriz de controles y veredicto por área) · [THREAT_MODEL.md](THREAT_MODEL.md) (STRIDE + DFD) · [RISK_REGISTER.md](RISK_REGISTER.md) · [SECURITY_ROADMAP.md](SECURITY_ROADMAP.md) (30/60/90) · [DATA_CLASSIFICATION.md](DATA_CLASSIFICATION.md) · [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) · [MULTITENANCY.md](MULTITENANCY.md) (aislamiento + verificador).
>
> Verificar aislamiento con el rol real de la app: `pnpm --filter @conversia/database verify:isolation` (también corre en CI, job `tenant-isolation`, bloqueante).


## Implementado

- **Aislamiento de tenants**: RLS + `withTenant` + colas con tenant (ver MULTITENANCY.md).
- **Webhooks Meta**: verificación HMAC SHA-256 (`X-Hub-Signature-256`) con comparación timing-safe; verify token en el GET de suscripción.
- **Auth**: bcrypt (cost 10) para contraseñas; JWT firmado HS256 con expiración; contexto por AsyncLocalStorage (no hay estado global mutable por request).
- **Validación de entrada**: zod en endpoints y en TODAS las tools de IA (server-side). La IA nunca ejecuta acciones sin pasar por el registro de tools con permisos.
- **Principio "la IA no inventa"**: precios/disponibilidad/profesionales solo vía tools que leen datos estructurados; los prompts seed lo refuerzan y el orquestador acota rondas de tools.
- **Credenciales**: variables de entorno; esquema `integration_credentials` cifrado AES-256-GCM (clave `CREDENTIALS_ENCRYPTION_KEY`, versionada) para credenciales por tenant.
- **Auditoría**: audit_logs en acciones sensibles (takeover, handoff, citas, creación de org); trazabilidad IA completa (ai_requests).
- **Config fail-fast**: producción exige JWT_SECRET y clave de cifrado no-default (`@conversia/config`).

## Pendiente antes de producción (checklist)

- [ ] Rate limiting (por IP y por tenant) en API y webhook.
- [ ] Protección SSRF para el nodo `call_api` de workflows (allowlist de esquemas/hosts, bloqueo de IPs privadas) — el nodo aún no está implementado, no habilitarlo sin esto.
- [ ] Refresh tokens + revocación de sesiones; 2FA para admins.
- [ ] Cliente Prisma admin separado (registro/ruteo) y conexión app con rol `conversia_app` en Railway.
- [ ] Sanitización/escaneo de archivos subidos (S3 pendiente).
- [ ] Backups automáticos + prueba de restauración documentada.
- [ ] Cabeceras (helmet), CORS restrictivo por dominio de tenant.
- [ ] Política de retención y anonimización (Ley 21.719 Chile: consentimiento, finalidad, minimización — los campos `consent`/`do_not_contact` existen y se respetan en workflows de seguimiento).
- [ ] Aprobaciones humanas activas (approval_requests) para: descuentos, envíos masivos, información clínica sensible.
- [ ] Defensa prompt-injection: además de tools acotadas, filtrar instrucciones del usuario que pidan cambiar rol/reglas (clasificador Haiku) y nunca interpolar contenido del contacto en el system prompt.

## Datos de salud

Las conversaciones pueden contener datos sensibles: minimizar lo que se envía al modelo (historial ventaneado, sin ficha clínica), no registrar contenido en logs de aplicación (solo IDs), y contratos de procesamiento de datos con Anthropic/Meta antes del piloto real.
