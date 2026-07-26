# Roadmap de seguridad — Conversia

Prioriza cerrar P0/P1 abiertos. Actualizado 2026-07-26.

## 30 días (P1 críticos operativos)

- **MFA (TOTP)** obligatorio para admin de plataforma y configurable/obligatorio para admin de tenant. Reautenticación para acciones críticas (rotar credenciales, exportar, desconectar Meta). — R-10
- **Prueba de restauración de backups**: documentar RPO/RTO reales de Railway, ejecutar una restauración a un entorno efímero y registrar evidencia. — R-17
- **Container scan (Trivy)** en CI sobre las imágenes de los Dockerfiles. — R-14
- **Verificación de correo** en el registro self-service.
- **Alertas mínimas**: fallos de webhook (DEAD), picos de costo de IA, `ai.budget_exceeded`, errores de autenticación anómalos → notificación (correo/webhook interno).

## 60 días (P1/P2 de profundidad)

- **Anti-replay en webhooks entrantes**: validar timestamp con ventana (±5 min) y nonce/dedupe por id de evento de Meta. — R-07
- **SSRF: mitigar DNS rebinding** fijando la IP resuelta en el momento del envío (lookup + conexión a la IP validada). — R-06
- **Revocación de sesión**: `tokenVersion` por usuario; invalidar al cambiar contraseña/rol/MFA; endpoint de "cerrar todas las sesiones". — R-15
- **Capa de política de datos a IA**: por tenant, campos permitidos/prohibidos, redacción de identificadores, marca de contenido de KB como no-confiable, configuración anti-entrenamiento por proveedor. — R-19, R-08
- **CSP con nonces** (eliminar `unsafe-inline` en scripts del panel). — R-12
- **Rate limit por IP en el borde**: poner Cloudflare (o equivalente) delante del panel y la API; reglas para `/auth/*`, webhooks y admin. — R-03, R-18
- **WAF administrado + ocultar el origen** (acceso directo a la API sólo vía borde).

## 90 días (madurez)

- **KMS / envelope encryption** para credenciales de integración; rotación de la clave maestra con versionado; auditoría de uso de claves. — R-09
- **Logs de auditoría inmutables** con retención separada (append-only / WORM).
- **Centro de seguridad** en el panel (estado, alertas, credenciales por vencer, integraciones con problemas, dependencias vulnerables, estado de backups).
- **DAST (OWASP ZAP)** autenticado contra staging en CI nocturno. — DAST
- **Firma de artefactos / provenance** (SLSA) y pin de dependencias por hash. — R-14
- **Gestión de solicitudes de titulares** (acceso, rectificación, supresión, portabilidad) y flujos de retención/anonimización — ver PRIVACY/DATA_RETENTION.
- **Pentest externo independiente** antes del uso masivo con datos clínicos reales. — 🔬

## Continuo

- Triage de hallazgos de CodeQL/gitleaks/audit por PR.
- Revisión trimestral del registro de riesgos y de accesos al repositorio.
- Actualización de dependencias con pruebas (sin auto-merge de mayores).
