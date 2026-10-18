# e2e de conversia-web (Playwright)

Pruebas de funcionalidad móvil + escritorio. **Nunca contra producción.**

## Proyectos (claro y oscuro)
`iphone` (iPhone 13), `iphone-light`, `pixel` (Pixel 7), `desktop` (1280×800), `desktop-light`. El tema se fija por `localStorage` antes del paint. `BASE` elige el objetivo (default `http://localhost:3002`).

## Dos conjuntos

- **`pwa.spec.ts`** — instalable + SW + offline + iconos + sin scroll horizontal. **No necesita backend** → corre contra `next start` y es el que corre en **CI** (job `e2e-conversia`).
- **`flows.spec.ts`** — flujos completos con API (alta → panel 30/30 → bandeja → cobros → ajustes notificaciones → prompt de instalación). Requieren el **stack Docker** (M6). Se activan con `RUN_FLOWS=1`; en CI se saltan.

## Correr

Solo PWA (sin backend):
```bash
PORT=3002 pnpm --filter @conversia/conversia-web start &
pnpm --filter @conversia/conversia-web test:e2e:pwa
```

Todo, contra el stack Docker (levántalo con `pnpm sim:up`):
```bash
BASE=http://localhost:3002 RUN_FLOWS=1 pnpm --filter @conversia/conversia-web test:e2e
```

Un solo proyecto: `... test:e2e --project=iphone`.
