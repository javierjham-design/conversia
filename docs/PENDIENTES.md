# Cabos sueltos — consolidado (2026-08-05)

Revisado contra memoria, `docs/PROGRESS.md` y `docs/PRELANZAMIENTO.md`. Estado real,
si sigue teniendo sentido y esfuerzo. Muchas migraciones que PROGRESS marcaba
"pendiente aplicar a prod" YA se aplicaron (prod tiene 18 migraciones, todas
aplicadas) — no se listan como abiertas.

Leyenda esfuerzo: S (horas) · M (1-2 días) · L (>2 días) · ⏳ (depende de terceros).

## A. Go-live de Meta / WhatsApp (lo que condiciona el lanzamiento)
| # | Ítem | Estado | ¿Sigue? | Esfuerzo |
|---|------|--------|---------|----------|
| A1 | **App Review de WhatsApp** (acceso Avanzado) | Enviada, PENDING veredicto | Sí — BLOQUEA autoservicio de terceros | ⏳ Meta |
| A2 | **`ads_read` OAuth** para que un cliente externo conecte SUS anuncios | En cola (ni pedido en la review) | Sí, pero solo cuando vendas conexión de anuncios a terceros | M + ⏳ review |
| A3 | **Línea de crédito compartida / OBO billing** (Meta cobra a TuBot, TuBot al cliente) | Parkeado, no implementado | Sí, si el modelo es reventa sin que el cliente ponga tarjeta en Meta | L + ⏳ |
| A4 | **Sync del catálogo de anuncios vs campañas reales** | Bloqueado: falta que cargues el token de Usuario del Sistema | Sí | S (tú cargas token) |
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
