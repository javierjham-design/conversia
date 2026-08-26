# Sistema de diseño de TuBot (panel del tenant)

Fuente de verdad de los tokens visuales. Base del rediseño de la Bandeja
(`feature/inbox-redesign`). Página de muestra navegable: **`/design`** (usa el
toggle claro/oscuro del sidebar para ver ambos modos).

Los tokens viven en `apps/web/src/app/globals.css` (Tailwind v4, `@theme`).

## Color

**Marca (único primario)** — azul, escala `brand-50…900`. Una sola familia de
acción; el cian/teal heredados quedan solo por compatibilidad y se retiran al
migrar cada zona.

**Neutro frío** — `slate` (escala completa de Tailwind) para superficies y
texto, expuesto vía tokens semánticos (abajo).

**Semánticos (acotados)**: éxito=`emerald`, error=`red`, info=`brand`.
- **REGLA del ámbar**: `amber` deja de ser decorativo. Se reserva a **atención
  requerida** (ventana de 24 h por cerrar, integración en error). Nada más.

## Superficies e "ink" (voltean claro↔oscuro)

Tokens semánticos que cambian por modo (utilidades Tailwind entre paréntesis):

| Token | Utilidad | Uso |
| --- | --- | --- |
| `--app` | `bg-app` | Fondo de la aplicación |
| `--panel` | `bg-panel` | Superficie de lista, sidebar claro, tarjetas base |
| `--raised` | `bg-raised` | Tarjetas/popovers/burbuja entrante (con sombra) |
| `--brand-soft` | `bg-brand-soft` | Fondo tenue con tinte de marca |
| `--line` / `--line-strong` | `border-line` / `border-line-strong` | Bordes 1px |
| `--ink` | `text-ink` | Texto primario (nombres, títulos) |
| `--ink-muted` | `text-ink-muted` | Texto secundario |
| `--ink-subtle` | `text-ink-subtle` | Metadatos (horas, contadores) |

Sombras de una sola familia: `shadow-e1` (sutil), `shadow-e2` (tarjeta/popover),
`shadow-e3` (modal). En oscuro son más profundas y suaves.

## Tipografía

Escala: **11 / 12 / 13 / 14 / 16 / 20** — `text-2xs` (11), `text-xs` (12),
`text-13` (13), `text-sm` (14), `text-base` (16), `text-xl` (20). Pesos
400/500/600. Nombres y títulos en 14–16 peso 600; metadatos en 11–12 `text-ink-subtle`.
Contadores y horas con `.tnum` (o `tabular-nums`) para que no bailen.

## Forma y espaciado

- Radios: **6px controles** (`rounded-control`), **10px tarjetas** (`rounded-card`),
  **16px burbujas** (`rounded-bubble`).
- Espaciado en múltiplos de 4 (utilidades estándar de Tailwind).
- Foco accesible unificado: anillo `2px brand-500` con offset en todo control
  interactivo (regla global `:focus-visible`).

## Modo oscuro

- Clase `.dark` en `<html>` (variante `@custom-variant dark`). Un script en el
  layout raíz la aplica **antes del primer paint** leyendo `localStorage`
  (`tubot-theme`) o `prefers-color-scheme` — sin parpadeo.
- Toggle en el pie del sidebar (`ThemeToggle`), persistido por usuario.
- Ambos modos cumplen **contraste AA** (ver abajo).

### Contraste (WCAG) — verificado

| Par | Claro | Oscuro |
| --- | --- | --- |
| ink / panel | 17.9 ✓ | 15.5 ✓ |
| ink-muted / panel | 6.3 ✓ | 8.2 ✓ |
| ink-muted / app | 5.7 ✓ | — |
| ink-subtle / panel (metadatos 11px) | 3.7 (AA-large) ✓ | 4.2 (AA-large) ✓ |
| blanco / brand-600 (burbuja saliente) | 5.2 ✓ | 5.2 ✓ |

Texto normal ≥ 4.5; metadatos 11px ≥ 3.0 (AA-large, apropiado para texto no
esencial). Recalcular con el script si se ajustan tonos.

## Micro-interacciones (base)

- Transiciones 150–200ms con easing suave (`transition-colors`, etc.).
- Skeletons con `.shimmer` en vez de spinners.
- Punto "en vivo" con `.live-dot` (late); gris cuando cae a sondeo.
- Todo respeta `prefers-reduced-motion` (regla global).

## Cómo se aplica

El rediseño migró la Bandeja por zonas (sidebar, lista, cabecera, hilo, panel,
compositor) usando estos tokens y luego se propagó al resto del panel
(Contactos, Configuración, Flujos, Reportes, Billing, Integraciones) en el
commit de coherencia global (CP8: barrido determinista neutros→tokens en 44
archivos). Cada zona "enciende" el modo oscuro al migrarse.

## Modo oscuro — cobertura completa del panel

Tras el rediseño de la Bandeja, el modo oscuro se pulió en **todo el panel** con
tres mecanismos aditivos (ninguno toca el modo claro ni la lógica):

1. **Barrido aditivo de variantes semánticas** — a cada fondo/texto/borde
   semántico claro (`bg-emerald-50`, `text-amber-700`, `border-red-200`, …) se
   le añadió su variante `dark:*` correspondiente (220 clases en 36 archivos).
   Solo agrega clases `dark:`; jamás modifica las claras → modo claro idéntico.
   Escala de mapeo: `bg-*-50→dark:bg-*-500/10`, `bg-*-100→/15`,
   `text-*-600→dark:text-*-400`, `text-*-700/800→-300`, `border-*-200→/30`.
2. **Base global de controles de formulario** — `input/select/textarea` heredan
   `bg-panel`/`text-ink` (y placeholder `ink-subtle`) salvo que una utilidad
   `bg-*` explícita gane por especificidad. Evita cajas blancas de formularios
   en oscuro en TODAS las pantallas (Configuración, Login, editores…).
3. **`navy-900` de contenido → `text-ink`** — el azul oscuro estático que se
   usaba como texto de encabezado no se voltea; se reemplazó por `text-ink` en
   Agentes, Flujos, barra superior, landing y demo. (El sidebar conserva su
   navy fijo a propósito: es una superficie siempre-oscura en ambos modos.)
4. **Escala de marca** — el mismo barrido aditivo se aplicó a `brand/accent/teal`
   (`bg-brand-50`, `text-brand-700`, `border-brand-300`, … → variantes `dark:`),
   67 clases en 18 archivos. Corrige chips/links/estados activos que quedaban
   claros en oscuro (p. ej. el ítem activo del clasificador de Contactos).

**Canvas de Flujos (ReactFlow):** overrides `.dark` en `globals.css` para los
botones de `Controls`, minimapa y atribución; el lienzo es `bg-app` y los nodos
`bg-panel`.

### Verificación con Playwright (ambos modos)

Recorrido automatizado a 1366–1440px capturando claro/oscuro:

- **Públicas contra producción** (`www.tubot.cl`): landing, login, demo — sin
  bloques blancos en oscuro (el único elemento claro en login es el botón de
  Google, que es su iframe de marca).
- **Panel contra build de producción local** (con sesión y API mockeada):
  Reportes, Plan y facturación, editor de Agentes, lista y **canvas** de Flujos,
  Horarios y lista de Agentes renderizan coherentes en oscuro (sidebar, tarjetas,
  tablas, inputs/selects, gráficos, badges y ReactFlow correctos).
- Nota de método (IMPORTANTE para el próximo que corra el harness): el recorrido
  usa **`next start`, no `next dev`**. La CSP de producción prohíbe `unsafe-eval`
  y el HMR de `next dev` usa `eval()` → no hidrata bajo esa CSP y **toda** página
  queda en blanco (no es un fallo de la app). Ver `apps/web/e2e/robustness/README.md`.

### Robustez ante datos incompletos

El recorrido con datos **deliberadamente incompletos** (tenant vacío y registros
con campos opcionales en `null`) destapó varias pantallas que se quedaban en
blanco con datos que un usuario real puede tener (contacto sin etiquetas,
conversación sin asignado, plan "a medida" sin precio, permisos sin definir,
horario sin configurar, series sin datos…). Se blindaron con optional chaining /
valores por defecto en 9 pantallas, se extrajo la lógica pura resistente a
`apps/web/src/lib/safe.ts` (con tests en `safe.test.ts`), y se añadió un **error
boundary** en `src/app/(app)/error.tsx`: si algo imprevisto falla al renderizar,
el usuario ve un estado amable con «Reintentar / Recargar» (sidebar intacto) en
vez de la pantalla de error de Next. El smoke que reproduce estos casos vive en
`apps/web/e2e/robustness/`.

**Pendiente conocido** (no bloquea): los bloques de código de
`/integrations/developers` se dejan como terminal oscuro intencional; el sidebar
aún no colapsa a solo-íconos; el envío se omitió como optimista a propósito (el
SSE ya se siente instantáneo).


## Programa de armonización de la UI (B0–B10)

Programa de orden visual «no se rompe nada de lo que hoy funciona»: solo
presentación, cero lógica de negocio, un PR por bloque con CI verde. Zonas
prohibidas respetadas (`apps/api/src/platform`, `apps/web/src/app/admin`).
PRs #246–#261.

### Sistema único de componentes (B4)
En `apps/web/src/components/ui.tsx`:

- `Select` — envuelve el `<select>` nativo con chevron propio, borde/foco/disabled
  unificados; acepta todos los `SelectHTMLAttributes`.
- `Checkbox` — casilla propia con check de marca (no depende del render del SO).
- `Switch` — interruptor pill `role="switch"` para on/off (`onChange(next: boolean)`).
- `DateInput` — fecha con `color-scheme` que voltea en oscuro.
- `Pagination` — paginación única «N / página» + Anterior/Página X de Y/Siguiente.
- `IconButton` (B5) — acción de fila: icono + tooltip, con variante `destructive`
  (rojo). Patrón único Editar (lápiz) · Duplicar (copia) · Eliminar (papelera).

Regla: los controles nativos sin estilo se reemplazan por estos. Se dejan
nativos, a propósito, los patrones ocultos (`sr-only`/`hidden`/overlay `opacity-0`)
y el radio (no hay `Radio` en el DS).

### Color primario único (B4)
Un solo azul de marca `brand-*` en toda la zona del tenant. El `cyan-*` se
eliminó (era un segundo primario). `teal`/`accent` quedan solo como acento. En
oscuro todo se apoya en tokens (`bg-app/panel/raised`, `text-ink/-muted/-subtle`,
`border-line`) que voltean solos.

### Logos reales (B4)
`apps/web/src/components/brand-icons.tsx` incluye logos oficiales (Simple Icons,
CC0): Shopify, WooCommerce, Zapier, Make, HubSpot, Google Analytics. El Centro de
Integraciones los mapea por `key` en `CATALOG_ICONS`.

### Textos (B8)
Español de Chile. Helper `plural(n, singular, plural?)` en `src/lib/plural.ts`
(«1 contacto» / «3 contactos») — nada de «(s)». Página 404 propia
(`src/app/not-found.tsx`). Etiquetas de rol humanizadas vía `src/lib/labels.ts`
(`roleLabel`). Ver el glosario en `docs/GLOSARIO.md` (fuente única de nombres).

### Overlays (B5)
`Modal`, `Drawer` y `ConfirmDialog` cierran con Escape y con clic en el fondo de
forma central; no hay overlays ad-hoc que se salten ese comportamiento.

### Diferido (reportado, no forzado)
Reestructurar todas las cabeceras a `PageHeader`, unificar anchos máximos y
sidebars secundarias son de alto churn con riesgo de recortar contenido → pasada
dedicada con capturas antes/después. Incoherencias que tocan backend/datos de
producción están inventariadas en `docs/COPY_PENDIENTE_OCT2026.md`.


## Etapa 2 — Sistema con carácter (B2: tokens y /styleguide)

Fuente única de la verdad en vivo: **`/styleguide`** (interna). Definido en
`apps/web/src/app/globals.css` (@theme) y las fuentes en `apps/web/src/app/layout.tsx`.

### Tipografía
Dos familias self-hosted por `next/font`: **Inter** (texto — buen soporte de
acentos y ñ) y **Sora** (títulos — carácter geométrico); mono del sistema. Roles
como clases utilitarias (usar estas, no `text-[10px]` sueltos):
`.t-display` 30 · `.t-page` 24 · `.t-section` 18 · `.t-card` 15 · `.t-body` 14 ·
`.t-body-sm` 13 · `.t-label` 12 · `.t-meta` 11 (solo contadores/horas) · `.t-mono` 13.
Cuerpo mínimo **14px**, etiquetas **12px**, interlínea 1.5 (1.25 en títulos).
`h1–h3` usan la familia display por defecto.

### Color
- **Marca** `brand-50→900`: SOLO para la acción primaria (un primario por pantalla).
- **Superficies** que voltean en oscuro: `app` (fondo), `panel`, `raised`,
  `line`, `line-strong`, e ink `ink`/`ink-muted`/`ink-subtle`.
- **Semánticos** `--color-success/-warning/-danger/-info` (con su tinte de fondo).
- **Paleta categórica** `--color-cat-1..8` (indigo/teal/amber/pink/violet/cyan/
  lime/orange): SIEMPRE para series de gráficos y para el color de las etapas del
  ciclo de vida. El nav activo, los chips y las barras de datos usan sus propias
  escalas — nunca el azul de marca.

### Superficie y profundidad
Tres elevaciones: base (`bg-app`), elevada (`bg-raised` + `shadow-e1`), flotante
(`shadow-e3`). Radios semánticos: `rounded-control` 6 · `rounded-card` 10 ·
`rounded-bubble` 16 · `rounded-pill`.

### Espaciado, estados, iconografía
Escala de 4px (Tailwind por defecto). Estados: hover/activo/seleccionado + foco
con anillo propio (`:focus-visible` con `--color-brand-500`), skeletons con
forma. Íconos: una sola familia de línea (lucide); los emoji salen del chrome del
producto (siguen permitidos en el contenido que el cliente escribe).

### Movimiento, acciones de fila y accesibilidad (B4/B7/B8)
- **Movimiento (B7):** `Modal`/`Drawer` entran con animación suave 150–200 ms
  (`.animate-overlay-in`, `.animate-modal-in`, `.animate-drawer-in` en globals.css),
  y respetan «prefiere menos movimiento» (la regla `@media (prefers-reduced-motion)`
  pone las animaciones ~0 ms). Los toasts (`useToast`) son el único sistema de avisos.
- **Acciones de fila (B4):** las filas/barras con muchos controles dejan 1–2
  acciones visibles y el resto en un menú «…» (patrón en Flujos, barra masiva de
  Clientes y fila de Canales). Los cuadros de texto de las Acciones del agente
  crecen con su contenido (auto-grow), no recortan el texto.
- **Accesibilidad (B8):** foco con anillo propio (`:focus-visible`); `ink-subtle`
  en oscuro subido para contraste; los botones de ícono usan el componente
  `IconButton` con área de clic cómoda.
