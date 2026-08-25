# Baseline visual — programa de armonización de UI (Bloque 0)

Referencia del "ANTES" del programa de armonización (2026-08-25). Capturas de
las pantallas del panel en claro (`light/`) y oscuro (`dark/`), tomadas contra
un build de producción local con la API mockeada (mismo patrón que
`apps/web/e2e/robustness/` — siempre `next start`, nunca `next dev`, por la CSP).

Regenerar:

```bash
pnpm --filter @conversia/web build
pnpm --filter @conversia/web start -p 3010
BASE=http://localhost:3010 node apps/web/e2e/ui-baseline/capture.mjs
```

Nota: los datos que se ven son los del mock (`nulls-mock.mjs`) — la referencia
es de **estructura, componentes, colores y layout**, no de contenido real.

## Constancia del verde inicial (2026-08-25, rama ui/armonizacion-b0)

- `pnpm typecheck`: 18/18 tareas OK
- Suite completa: **400 tests verdes** (web 82 · agents 36 · worker 218 · api 64)
- Probe de robustez (`e2e/robustness/probe.mjs`): escenarios VACÍO y NULLS,
  todas las pantallas ✅ (ninguna revienta)

Cualquier rojo posterior a esta fecha es responsabilidad del programa de
armonización.

## Reglas del programa (resumen operativo)

- Cero cambios de lógica de negocio; intocables: compuertas de envío, billetera
  prepago, fusible global, aislamiento por organización, montaje asistido.
- Etiquetas visibles se renombran en presentación; claves internas, slugs,
  rutas de API e identificadores de eventos NO se renombran.
- No tocar `apps/api/src/platform` ni `apps/web/src/app/admin`.
- Un PR por bloque, CI verde en cada merge.
