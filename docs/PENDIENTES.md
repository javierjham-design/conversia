# Cabos sueltos — consolidado (2026-08-05)

Revisado contra memoria, `docs/PROGRESS.md` y `docs/PRELANZAMIENTO.md`. Estado real,
si sigue teniendo sentido y esfuerzo. Muchas migraciones que PROGRESS marcaba
"pendiente aplicar a prod" YA se aplicaron (prod tiene 18 migraciones, todas
aplicadas) — no se listan como abiertas.

Leyenda esfuerzo: S (horas) · M (1-2 días) · L (>2 días) · ⏳ (depende de terceros).

## 0. Seguridad (post-auditoría 2026-08-10 — ver docs/SECURITY_AUDIT.md)
Bloque grande pendiente: **bolsa de mensajes prepagada** (Eje 1.2, requiere
migración a OK del dueño) — la protección estructural definitiva. La mitigación
puente (fusible global + topes por tenant + demo/gracia sin plantillas + alerta de
WABA huérfana) YA está desplegada.
Medios agendados (endurecimiento, no bloqueantes):
| # | Ítem | Ref | Esfuerzo |
|---|------|-----|----------|
| S-1 | Revocación de sesiones de tenant al cambiar clave/rol (jti denylist / tokenVersion) | M2 | S |
| S-2 | `audit_logs` inmutable a nivel de motor (`REVOKE UPDATE,DELETE` + trigger) | M3 | S (migración corta) |
| S-3 | Allowlist de IP para el Super Admin (`SUPER_ADMIN_ALLOWED_IPS`) | M4 | S (config) |
| S-4 | Validar monto == precio de plan en el webhook de pago | M5 | S |

## 0-bis. Bolsa prepagada — follow-ups (bloque 2 cerrado 2026-08-10)
La bolsa está desplegada y funcionando (débito atómico, avisos 80/100%, compra de
paquete Flow/mock, márgenes, CRUD de paquetes). La **recarga ocurre también al
renovar el período** (billing.activate → topUpWallet, con carryover de 1 mes), no
solo en el primer pago. Bolsas de tenants activos cargadas (Digital Dent/TuBot 4000,
Clínica Demo 0). Pendientes menores:
| # | Ítem | Nota | Esfuerzo |
|---|------|------|----------|
| W-1 | **Prueba e2e real de la bolsa** con **número de producción** | Digital Dent está en el número de PRUEBA de Meta (no cobra, no valida /admin/margins). Hacer un envío real que valide las 5 capas el día que la WABA de producción esté viva (App Review). | S |
| W-2 | **Refund al fallar el envío** | Hoy se debita ANTES de enviar; si Meta rechaza el mensaje de forma terminal (tras reintentos), el crédito queda consumido sin envío. Devolver el crédito en fallo terminal (cuidando idempotencia con los reintentos). | S |
| W-3 | **Compra de paquete por Lemon Squeezy (USD)** | Requiere un producto de pago único en LS (distinto de la suscripción) + manejo de `order_created`. Hoy: Flow (CLP) + mock. | M |

## A. Go-live de Meta / WhatsApp (lo que condiciona el lanzamiento)
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| A1 | **App Review de WhatsApp** (acceso Avanzado) | ✅ **APROBADA (2026-08-11)**: whatsapp_business_messaging, whatsapp_business_management, business_management, public_profile. ❌ `whatsapp_business_manage_events` **RECHAZADA** por prerrequisito ("no advanced access to whatsapp_business_messaging or policy violation in last 90 days") — es huevo-y-gallina (messaging recién se aprobó). **Acción:** cuando el acceso avanzado de messaging esté efectivo, **"Volver a solicitar"** solo ese permiso. Sirve solo para conversiones de anuncios CTWA, no para operar. | Parcial | ⏳ Meta |
| A2 | **`ads_read` — seleccionar campañas activas en los flujos** | La plataforma **no usa OAuth para anuncios**; se activa cargando un **token de Usuario del Sistema con `ads_read`** en Integraciones → Meta. Para tu **propia** cuenta (TuBot/Digital Dent) **funciona YA**, sin depender de App Review. El OAuth self-service para que **terceros** conecten sus anuncios sigue siendo futuro. | Sí (cargar token) | S (tú) |
| A2-bis | **`whatsapp_business_manage_events` vía token** (mientras se reaprueba) | El mismo token de Usuario del Sistema puede incluir `whatsapp_business_manage_events` para enviar conversiones CTWA sin esperar el reintento de App Review (asignación directa sobre tu WABA). | Sí (mismo token) | S (tú) |
| A3 | **Línea de crédito compartida / OBO billing** (Meta cobra a TuBot, TuBot al cliente) | Parkeado, no implementado | Sí, si el modelo es reventa sin que el cliente ponga tarjeta en Meta | L + ⏳ |
| A4 | **Sync del catálogo de anuncios vs campañas reales** | Bloqueado: falta que cargues el token de Usuario del Sistema (con `ads_read` para campañas y, opcional, `whatsapp_business_manage_events` para conversiones). Un mismo token cubre ambos. | Sí | S (tú cargas token) |
| A5 | **Toggles del dashboard de Meta** (deauth callback, app secret proof, 2FA, verificar email) | Código listo (PR #39); pendiente activarlos tras el veredicto | Sí | S (tú, con `docs/META_SETUP.md`) |
| A6 | **Verificar acceso del revisor** + configurar **BetterStack** | Pendiente tuyo | Sí | S (tú) |

## B. Producto / UX
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| B1 | **Onboarding guiado** para no-técnicos (qué es un "flujo", tour) | No existe (solo checklist + ayuda por sección) | Sí — reduce soporte y abandono | M |
| B2 | **Canal de soporte in-app** (el cliente reporta, tú lo ves) | No existe | Sí | S-M |
| B3 | **Guía de plantillas de WhatsApp** con textos sugeridos por rubro | Parcial (panel con estado de sync; falta la guía) | Sí | M (se cruza con Bloque 8) |
| B4 | **Plantilla `recordatorio_cita` en Meta + publicar flujo corregido** | Pendiente tuyo (crear la plantilla HSM en Meta) | Solo si usas recordatorios fuera de 24 h | S (tú) |
| B5 | Invitación de usuario **por token con expiración** (hoy es mensaje copiable) | Brecha anotada | Sí, menor | S |
| B6 | **Reagendar** cita desde el recordatorio = auto-reprogramar (hoy deriva a humano) | Por diseño v1 (handoff) | Opcional; el handoff funciona | M |

## C. Triggers / canales "Próximamente"
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| C1 | Trigger **llamada perdida** (`missed_call`) | Estructura lista, sin fuente de evento | Nice-to-have | M |
| C2 | **Anuncios TikTok** (trigger + `send_tiktok_event`) | Próximamente | Solo si abres canal TikTok | L |
| C3 | **Instagram DM / Messenger** en la bandeja | Próximamente | Sí a futuro (multicanal) | L + ⏳ review |

> Nota: las 11 tarjetas del hub de Integraciones (Google Calendar/Sheets, HubSpot, GA4,
> Email, API personalizada, Zapier/Make, Dentalink, Agenda personalizada, Webhooks)
> **YA están "Disponible" y cableadas** (PR #14) — no son pendientes.

## D. Seguridad (del RISK_REGISTER / SECURITY_STATUS)
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| D1 | **Restauración de backup probada** (RTO/RPO) | ← **Bloque 6 (en curso)** | Sí | — |
| D2 | **Retención + borrado configurable + DPA** | ← **Bloque 7** | Sí | — |
| D3 | **MFA plataforma (Super Admin)** | El MFA de tenant ya existe; falta el del panel admin | Sí | M |
| D4 | **Revocación de sesión / logout global** (JWT stateless → tokenVersion) | Pendiente | Sí, medio | M |
| D5 | **KMS / rotación de la clave de cifrado** | Clave única sin rotación | Sí, a futuro | M |
| D6 | **Anti-replay en webhooks** (timestamp/nonce) | Pendiente | Sí, medio | S-M |
| D7 | **Rate limit por IP en el borde** (Cloudflare/WAF) | Pendiente (hay por email/usuario) | Sí | S (infra) |
| D8 | **Container scan (Trivy)**, **CSP nonces**, **DAST/pentest externo** | Pendientes | Antes de uso masivo | M/⏳ |
| D9 | **Capa de política de datos permitidos/prohibidos a la IA** + clasificar KB como no-confiable | Pendiente | Sí, sube con datos sensibles | M |
| D10 | Constraint DB **unique (org, phone)** en contactos | Propuesta, no aplicada | Menor | S + migración |

## E. Operación
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| E1 | **Panel de alertas in-app** (`system_alerts`) para el Super Admin | Esquema existe, panel no | Nice-to-have (BetterStack cubre lo urgente) | M |
| E2 | **Tasa de fallos de envío** como serie temporal | No | Nice-to-have | S |
| E3 | **Watch paths por servicio** en el deploy (no recompilar los 3) | Pendiente | Menor (costo build) | S |
| E4 | **Snapshots de uso / reserva atómica de tokens / add-ons / versionado de planes** | Pendiente (requiere DDL) | A futuro (facturación por consumo) | L + migración |

## F. Cerrados o descartados (para que no reaparezcan)
- ✅ Filtro **"origen: campaña"** en Contactos (PR #35).
- ✅ **AGENDA-2** respuestas del recordatorio: Confirmar con write-back real; Reagendar → handoff (v1).
- ✅ **`appointment.serviceName`** cableado (bloque 1 lo espeja desde el webhook).
- ✅ **Suspensión por impago** + "sin plan = ilimitado" (PR #41).
- ✅ **MFA TOTP** de tenant (PR #42, migración en prod).
- ✅ **Monitoreo** `/health/status` + heartbeat (PR #40).
- ✅ **appsecret_proof + callbacks de app** (deauth/data-deletion) (PR #39).
- ❌ **Facturación tributaria (DTE)** — DESCARTADA del producto (va fuera, por método de pago).

## Recomendación de priorización antes del lanzamiento
- **Sí o sí:** A1 (esperar) + A5/A6 (tú) · Bloque 6 (backup) · Bloque 7 (retención/borrado/DPA).
- **Primeros 5 clientes:** B1 (onboarding), B2 (soporte), B3+Bloque 8 (rubro/plantillas), D3 (MFA admin), D4 (logout global).
- **Después / según demanda:** C1-C3, D5-D10, E1-E4, A2/A3 (cuando vendas anuncios/reventa a terceros).
