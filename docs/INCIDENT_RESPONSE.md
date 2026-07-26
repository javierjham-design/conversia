# Plan de respuesta a incidentes — Conversia

Actualizado 2026-07-26. Marco NIST (Preparación → Detección → Análisis → Contención → Erradicación → Recuperación → Lecciones). Roles: en el MVP el propietario del producto actúa como responsable de incidentes; escalar a soporte externo/legal según impacto.

## Preparación (controles ya disponibles)

- **Kill switches**: IA global (`AI_GLOBAL_KILL_SWITCH=true`) y por tenant (endpoint `PUT /organizations/me/ai-killswitch`).
- **Pausa de workflows**: desactivar por workflow (`active=false`) o por tenant.
- **Revocar integración**: desconectar Meta / Cláriva / webhook desde el panel (deja las credenciales inválidas para nuevas llamadas).
- **Rotar secretos**: variables en Railway; rotar `JWT_SECRET` invalida todas las sesiones; rotar `CREDENTIALS_ENCRYPTION_KEY` requiere re-cifrado (procedimiento pendiente — ver roadmap KMS).
- **Auditoría**: `audit_logs` e `integration_events` para reconstruir la línea de tiempo.
- **Verificador de aislamiento**: `pnpm --filter @conversia/database verify:isolation` para confirmar que no hubo fuga cross-tenant.

## Canales de emergencia

- Contacto responsable: (definir) — correo/teléfono fuera de banda.
- Panel de Railway: escalar/pausar servicios, rotar variables, ver logs.
- GitHub: revocar tokens, revisar Actions/Secret scanning.

## Playbooks

### 1. Cuenta / admin comprometido
1. Detección: login anómalo, cambios de permisos no reconocidos (audit_logs).
2. Contención: rotar `JWT_SECRET` (invalida todas las sesiones) y forzar cambio de contraseña del usuario.
3. Análisis: revisar audit_logs del actor (exportaciones, cambios de integración, publicaciones).
4. Erradicación: desactivar la cuenta, revisar reglas creadas por el atacante (webhooks, workflows).
5. Recuperación: restaurar configuración legítima; habilitar MFA (cuando exista).

### 2. Secreto expuesto (repo / logs / chat)
1. No mostrar el secreto completo; tratar como incidente.
2. Rotar inmediatamente en Railway y en el proveedor (Meta/Cláriva/IA/DB).
3. Eliminar del código; evaluar limpieza controlada del historial Git.
4. Revisar accesos que pudo tener el secreto; documentar.

### 3. Acceso cruzado entre tenants (sospecha)
1. Contención: si hay explotación activa, considerar modo mantenimiento del endpoint afectado.
2. Verificación: correr `verify:isolation`; revisar RLS (`sql/setup.sql`) y el rol de conexión de los servicios.
3. Análisis: buscar en audit_logs accesos con `organization_id` cruzado.
4. Erradicación: corregir la ruta de acceso (guard/RLS) + test de regresión.

### 4. Token de Meta / integración comprometido
1. Desconectar la integración desde el panel (invalida su uso).
2. Revocar el token en Meta Business / rotar la API key de Cláriva.
3. Revisar `integration_events` por envíos/lecturas sospechosas.
4. Reconectar con credenciales nuevas y scopes mínimos.

### 5. Prompt injection exitosa / agente fuera de control
1. Kill switch de IA del tenant (o global si es transversal).
2. Revisar la conversación y las tools ejecutadas (`messages.payload.toolEvents`, `ai_requests`).
3. Erradicación: ajustar prompt/tools del agente, reforzar sanitización, publicar versión corregida.
4. Confirmar que no se ejecutaron acciones no autorizadas ni hubo exfiltración.

### 6. Abuso de costo de IA / DoS económico
1. `ai.budget_exceeded` ya frena por tope diario; bajar el tope o activar kill switch.
2. Identificar el tenant/conversación origen; aplicar rate limit adicional.
3. Revisar si es bot/automatización → bloquear.

### 7. Webhook saliente hacia destino malicioso / SSRF
1. Pausar/eliminar el webhook del tenant.
2. Confirmar que el guard SSRF bloqueó destinos internos (logs de `webhook.dead`).
3. Revisar entregas; rotar el secreto de firma.

### 8. Ransomware / pérdida de datos
1. Contención: aislar; no pagar.
2. Recuperación desde backups de Railway (procedimiento de restauración — pendiente de prueba, roadmap 30d).
3. Postmortem y refuerzo de inmutabilidad de backups.

## Post-incidente

- Postmortem sin culpas: qué pasó, impacto, causa raíz, detección, tiempo de respuesta, acciones.
- Actualizar RISK_REGISTER y SECURITY_ROADMAP con las lecciones.
- Evaluar obligación de notificación (autoridad/afectados) según normativa vigente — consultar asesoría legal (no incluida aquí).
