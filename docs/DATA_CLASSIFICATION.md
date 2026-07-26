# Clasificación de datos — Conversia

Actualizado 2026-07-26. Guía el cifrado, retención, logging y qué puede enviarse a IA/integraciones.

## Niveles

| Nivel | Descripción | Ejemplos en Conversia |
|-------|-------------|-----------------------|
| **Público** | Divulgable sin daño | Nombre comercial del tenant, catálogo de integraciones, estados de planes |
| **Interno** | Operativo no público | Configuración de agentes/workflows, métricas agregadas, plantillas |
| **Confidencial** | Daño si se filtra | Contactos, conversaciones, leads, citas, campos personalizados, usuarios |
| **Sensible / restringido** | Daño alto; incluye datos personales y potencialmente clínicos | Documentos/audios de pacientes, motivo de consulta, RUT/identificadores, **credenciales/tokens**, secretos, claves de cifrado, logs de auth, backups |

## Tratamiento por nivel

| | Confidencial | Sensible / restringido |
|---|---|---|
| **Dónde se almacena** | PostgreSQL (RLS por tenant) | PostgreSQL (RLS) + campo cifrado AES-256-GCM para credenciales/secretos |
| **Quién accede** | Usuarios del tenant según rol; app vía `withTenant` | Sólo server-side; credenciales descifradas nunca salen del backend; admin plataforma sólo con auditoría |
| **Cifrado en tránsito** | TLS | TLS |
| **Cifrado en reposo** | Gestionado por Railway (volumen) | + cifrado a nivel de campo para secretos |
| **Retención** | Configurable por plan (pendiente job de purga) | Mínima; credenciales rotables/revocables |
| **Logs** | Sólo IDs y metadatos; nunca el cuerpo clínico completo | **Prohibido** en logs (tokens, secretos, contraseñas, payloads sin sanitizar) |
| **A modelos de IA** | Historial ventaneado (sin ficha clínica); minimizar | **Prohibido** enviar secretos; datos clínicos: capa de política por tenant (pendiente) |
| **A integraciones externas** | Sólo lo necesario para la finalidad (agenda, conversión) | CAPI hashea PII (SHA-256); nunca secretos de otros proveedores |

## Reglas duras (invariantes)

1. Ningún secreto/token/clave se escribe en el repositorio, en logs ni se envía al frontend.
2. Las credenciales de integración se guardan cifradas (AES-256-GCM) y se descifran sólo en el backend para usarlas.
3. Los datos de un tenant nunca cruzan a otro (RLS + `withTenant`; ver MULTITENANCY_SECURITY / verificador).
4. La IA no recibe secretos y no accede a la base de datos.
5. Los payloads publicados a webhooks/actividad se sanitizan (se quitan claves con pinta de secreto).
6. Los teléfonos enviados a Meta CAPI van normalizados y hasheados (SHA-256).

## Datos clínicos

Las conversaciones pueden contener información de salud. Antes del piloto real con datos de pacientes se requiere: contratos de tratamiento de datos con Anthropic/OpenAI/Meta, la capa de política de datos a IA (roadmap 60d), y verificación de la normativa chilena vigente (Ley 21.719) — ver PRIVACY. Este documento es técnico, no asesoría legal definitiva.
