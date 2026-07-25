# Planes y facturación

Estado MVP: **facturación desactivada, consumo registrado desde el día 1**.

- `plans` (code, limits Json, features Json, priceUsd) — seed crea "starter".
- `subscriptions` por organización (items Json para addons).
- `usage_events`: ai_tokens (con costo USD real por request), mensajes, ejecuciones — base de cualquier modelo de cobro posterior. Endpoint `/organizations/me/usage` ya agrega 30 días.
- `ai_requests`: detalle por llamada (modelo, tokens, costo, latencia) para márgenes por tenant.

Pendiente fase 7: enforcement de límites por plan (middleware al crear agentes/canales y contador mensual de tokens con corte/aviso), entidades de cobro (invoices, payment_methods, credits, overage_rules), pasarela (definir CLP/USD — alineado con la estrategia de facturación de Cláriva), y panel de plan por tenant.
