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

**Pendiente conocido** (no bloquea): los bloques de código de
`/integrations/developers` se dejan como terminal oscuro intencional; algunas
páginas interiores tienen modo oscuro aproximado donde el barrido no alcanza
colores semánticos puntuales; el sidebar aún no colapsa a solo-íconos; el
envío se omitió como optimista a propósito (el SSE ya se siente instantáneo).
