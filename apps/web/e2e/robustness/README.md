# Smoke de robustez del panel (datos incompletos)

Carga cada pantalla del panel con datos **deliberadamente incompletos** y falla
si alguna revienta (pantalla en blanco). Cubre los dos casos que un usuario real
puede encontrar:

- **VACÍO** (`empty-mock.mjs`): tenant nuevo sin nada (listas vacías, contadores
  en cero).
- **NULLS** (`nulls-mock.mjs`): registros presentes pero con campos opcionales en
  `null` (contacto sin etiquetas, conversación sin asignado, plan "a medida" sin
  precio, permisos sin definir, horario sin configurar, series sin datos…).

## Cómo correrlo

Necesita un servidor de **producción** (no `next dev`) y Playwright:

```bash
pnpm --filter @conversia/web build
pnpm --filter @conversia/web start -p 3010 &
npx playwright install chromium   # una vez
BASE=http://localhost:3010 node apps/web/e2e/robustness/probe.mjs
```

Sale con código ≠ 0 si alguna pantalla lanza un error de render.

## Por qué `next start` y no `next dev`

La CSP de producción (ver `next.config.mjs`) prohíbe `unsafe-eval`. El HMR de
`next dev` usa `eval()` para recargar módulos, así que bajo esa CSP el cliente
no hidrata y **toda** página queda en blanco (no es un fallo de la app). El
recorrido visual/robustez debe hacerse siempre contra `next start`.

## Complemento

La lógica pura resistente a nulos está además cubierta por tests unitarios en
`src/lib/safe.test.ts` (corren en el `vitest` del CI). Este probe es el smoke de
integración a nivel de página. La red de seguridad en runtime es el error
boundary de `src/app/(app)/error.tsx`, que muestra un estado amable con
reintentar/recargar en vez de la pantalla de error de Next.
