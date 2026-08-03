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
- Nota de método: el recorrido usa `next start` (no `next dev`), porque la CSP de
  producción prohíbe `unsafe-eval` y el HMR de dev no hidrata bajo esa CSP.

**Pendiente conocido** (no bloquea): los bloques de código de
`/integrations/developers` se dejan como terminal oscuro intencional; el sidebar
aún no colapsa a solo-íconos; el envío se omitió como optimista a propósito (el
SSE ya se siente instantáneo).
