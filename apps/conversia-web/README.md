# conversia-web (F3)

Frontend de **Conversia** (segunda marca). App Next.js **propia**, con design system
aparte (ver `src/app/globals.css`, identidad "Nocturna": modo oscuro de vidrio esmerilado
+ modo claro de porcelana, acento curado configurable). Habla con la **MISMA API** de la
plataforma (un backend, dos frontends — ver `docs/CONVERSIA_MONTAJE.md`).

- **Dev:** `pnpm --filter @conversia/conversia-web dev` (puerto 3002). Requiere la API arriba.
- **Env:** `NEXT_PUBLIC_API_URL` (apunta a la api EXISTENTE; en dev `http://localhost:4000`).
- **Regla dura:** PROHIBIDO importar de `apps/web` (ESLint `no-restricted-imports`). Solo `packages/*`.
- **Deploy:** servicio `conversia-web` en el MISMO proyecto Railway (ver `docs/DEPLOYMENT.md`).

## Estado (Tramo 1)

Scaffold + design system (tokens oscuro/claro + 6 acentos) + auth (login contra `/auth/login`)
+ home "Hoy" con saludo según la hora y widget de créditos (semántico, consume
`GET /billing/wallet/summary` de F5). **Pendientes (tramos siguientes):** bandeja estilo
WhatsApp, agenda, clientes, facturación completa, ajustes, navegación unificada (riel/tabs),
registro visual por vertical, persistencia del acento vía `PATCH /me/preferences`.
