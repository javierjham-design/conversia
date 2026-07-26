# Registro de riesgos — Conversia

Actualizado 2026-07-26. Escala de nivel = Probabilidad × Impacto. Estado: `mitigado` · `parcial` · `pendiente` · `aceptado` · `transferido`.

| ID | Activo | Amenaza / Vulnerabilidad | Prob. | Impacto | Nivel | Control actual | Riesgo residual | Estado | Prioridad |
|----|--------|--------------------------|-------|---------|-------|----------------|-----------------|--------|-----------|
| R-01 | Datos de tenant | Acceso cruzado entre tenants (BOLA/IDOR) | Media | Crítico | **Crítico** | RLS + `withTenant` + rol app sin bypass + verificador 19/19 + sondeo API 404 | Bajo | mitigado | P0 |
| R-02 | PostgreSQL | App conecta como superusuario → RLS evadible | Baja | Crítico | **Alto** | Rol `conversia_app` sin BYPASSRLS; admin sólo registro/login/ruteo | Bajo | mitigado | P0 |
| R-03 | Autenticación | Credential stuffing / fuerza bruta | Alta | Alto | **Alto** | Rate limit por email + por usuario | Medio (falta límite por IP en el borde) | parcial | P1 |
| R-04 | Sesiones/JWT | Algorithm confusion, token forjado | Media | Crítico | **Alto** | HS256 fijo + iss/aud + jti + tests | Bajo | mitigado | P1 |
| R-05 | Costo IA | Consumo ilimitado (loops, abuso) | Media | Alto | **Alto** | Kill switch global+tenant + tope diario tokens + maxToolRounds/maxTokens | Medio (falta tope por-conversación y alerta de costo) | parcial | P1 |
| R-06 | Webhooks salientes | SSRF a red interna / metadata | Media | Alto | **Alto** | Guard SSRF (privadas/loopback/interno/credenciales en URL) + tests | Medio (DNS rebinding: no re-resuelve al enviar) | parcial | P1 |
| R-07 | Webhooks entrantes | Falsificación / replay de Meta | Media | Alto | **Alto** | Firma HMAC obligatoria; canal mock exige token | Medio (sin ventana de timestamp/nonce anti-replay) | parcial | P1 |
| R-08 | Agentes IA | Inyección indirecta de prompt (LLM01) | Alta | Medio | **Alto** | Sanitización de variables; history en rol `user`; tools con permiso por agente; la IA no toca la BD | Medio (contenido de KB/documentos no clasificado como no-confiable aún) | parcial | P1 |
| R-09 | Credenciales integración | Fuga de tokens Meta/Cláriva | Baja | Crítico | **Alto** | AES-256-GCM en reposo, enmascarado, nunca al frontend, descifrado sólo server-side | Medio (clave única sin rotación/KMS ni envelope) | parcial | P1 |
| R-10 | Cuentas admin | Robo de cuenta sin MFA | Media | Crítico | **Alto** | Password ≥10, bcrypt 12, rate limit | **Alto** (sin MFA) | pendiente | P1 |
| R-11 | Errores API | Fuga de stack/detalle interno | Media | Bajo | Medio | Filtro global: 500 opaco con errorId + requestId | Bajo | mitigado | P2 |
| R-12 | Navegador | Clickjacking / XSS / MIME sniffing | Media | Medio | Medio | helmet (API) + CSP/HSTS/X-CTO/frame-ancestors (web) | Medio (CSP con `unsafe-inline` en scripts) | parcial | P2 |
| R-13 | Auth | Enumeración de usuarios | Media | Bajo | Medio | Mensajes genéricos login+registro + rate limit | Bajo | mitigado | P2 |
| R-14 | Cadena de suministro | Dependencia comprometida / secreto commiteado | Media | Alto | **Alto** | Lockfile; CI: gitleaks (bloqueante), pnpm audit, CodeQL, SBOM | Medio (sin firma de artefactos ni pin por hash) | parcial | P1 |
| R-15 | Sesiones | Sin revocación / logout global | Media | Medio | Medio | Expiración 12h | Medio | pendiente | P2 |
| R-16 | Archivos | Malware / zip bomb / traversal | Baja | Alto | Medio | — | **N/A hoy** (no hay endpoint de carga); riesgo aparece al construir la función | aceptado (temporal) | P1 al construir |
| R-17 | Backups | Inaccesibles / ransomware | Baja | Crítico | **Alto** | Backups gestionados por Railway | **Alto** (sin prueba de restauración ni inmutabilidad verificada) | transferido/pendiente | P1 |
| R-18 | Infra | Exposición directa de Postgres/Redis | Baja | Alto | Medio | Red privada de Railway; sin puertos públicos de datos | Bajo (Postgres tiene proxy público con credenciales — usado sólo para ops) | parcial | P2 |
| R-19 | Privacidad | Datos clínicos enviados a IA sin control fino | Media | Alto | **Alto** | Historial ventaneado (sin ficha clínica); mock por defecto | Medio (falta capa de política campos permitidos/prohibidos por tenant) | pendiente | P1 |
| R-20 | RAG | Recuperación cross-tenant / documentos no publicados | Baja | Crítico | Medio | Búsqueda dentro de `withTenant` (RLS); precios/horarios NO dependen sólo del RAG | Bajo (embeddings vectoriales aún no activos) | mitigado (parcial) | P1 al activar |

## Excepciones de riesgo aceptadas (formales)

| ID | Riesgo | Motivo | Mitigación compensatoria | Expira | Aprobado por |
|----|--------|--------|--------------------------|--------|--------------|
| EXC-01 | R-16 (archivos) | La función de carga de archivos no existe aún | Se construirá con pipeline de cuarentena+antimalware ANTES de habilitarla | Al implementar carga | CISO (rol) |
| EXC-02 | R-17 (restauración) | Requiere ventana operativa y entorno de staging | Backups automáticos de Railway activos | 30 días | CISO (rol) |
| EXC-03 | R-03 (IP en borde) | Rate limit por IP correcto vive en el WAF/CDN, no en la app tras el proxy | Límite por email+usuario ya activo | 60 días (Cloudflare) | CISO (rol) |
