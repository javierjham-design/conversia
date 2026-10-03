# CONVERSIA — DISEÑO FINAL DE LA PLATAFORMA (brief consolidado)

**Fecha de cierre:** 2026-10-01 (decidido tras 11 versiones de maquetas con Javier)
**Referencia visual canónica:** artifact "Direcciones visuales Conversia" v11 — https://claude.ai/artifact/7mDgGxQWu9yTb8v7EjeT9a (el HTML de la maqueta es la fuente de los valores exactos; este doc los consolida).
**Jerarquía:** si algo choca, mandan el prompt F3 de `PROMPTS_CONVERSIA.md` y los ajustes de auditoría. Este doc es el brief de diseño consolidado para implementar `apps/conversia-web`.

---

## 1. Identidad

**"Nocturna"**: una sola interfaz con dos pieles por tokens — modo oscuro (grafito azulado + vidrio esmerilado + luz ambiental) y modo claro (porcelana luminosa, MISMO layout y componentes). El modo jamás cambia estructura: solo cambia el set de tokens.

- **Tipografía**: Fraunces (serif display; pesos 500–700 + itálica — marca, saludos con cursiva, titulares, cifras grandes) + Inter (400–800 — cuerpo, tablas, números con `font-variant-numeric: tabular-nums`). Google Fonts.
- **Radios**: tarjetas 16px · botones/chips 9–11px · píldoras 999px. Iconografía: SVG stroke 1.8, estilo Lucide, un solo set.
- **Luz ambiental** (solo decorativa): 2–3 blobs blur(80px) con el color del acento a opacidad .10–.13 (oscuro) / .12–.16 (claro), deriva lenta 16–24s, **se apaga con `prefers-reduced-motion`**.

## 2. Tokens por modo

### Oscuro (default visual de marketing)
```
--m-bg:    linear-gradient(176deg,#0d1016 0%,#090b0f 55%,#07080b 100%)  /* jamás #000 puro */
--m-ink:   #ecedf0        --m-mut: #8d9199
--m-hair:  rgba(255,255,255,.06)      --m-hair2: rgba(255,255,255,.05)
--m-side:  rgba(11,13,17,.45) + backdrop-blur(16px)       /* riel/paneles */
--m-card:  rgba(255,255,255,.04)  borde rgba(255,255,255,.075)
           + inset 0 1px 0 rgba(255,255,255,.06)          /* vidrio */
--m-track: rgba(255,255,255,.08)
--m-ok:    texto #9fe0c3 · fondo rgba(110,220,170,.09) · borde rgba(110,220,170,.24)
--m-warn:  #e5b164 · fondo rgba(229,177,100,.09) · borde rgba(229,177,100,.3)
--m-doodle:rgba(255,255,255,.028)   /* textura del hilo de chat */
```
### Claro (default operativo diario)
```
--m-bg:    linear-gradient(176deg,#fbfaf7 0%,#f4f2ec 60%,#efede6 100%)
--m-ink:   #1d1f22        --m-mut: #70747b
--m-hair:  rgba(25,28,24,.09)         --m-hair2: rgba(25,28,24,.07)
--m-side:  rgba(255,255,255,.66) + blur(16px)
--m-card:  rgba(255,255,255,.74)  borde rgba(25,28,24,.09)
           + sombra 0 8px 26px rgba(25,28,20,.07) + inset 0 1px 0 rgba(255,255,255,.85)
--m-track: rgba(25,28,24,.10)
--m-ok:    #13795b · fondo rgba(19,121,91,.08) · borde rgba(19,121,91,.22)
--m-warn:  #9a6c10 · fondo rgba(176,127,35,.10) · borde rgba(176,127,35,.28)
--m-doodle:rgba(25,28,24,.035)
```

## 3. Acento configurable por usuario (feature de producto)

Paleta curada de 6 — nunca color libre. Cada acento define el set completo para AMBOS modos: `acc` (color), `acc-deep` (profundo, y color de texto/links en modo claro), `acc-ink` (texto sobre el acento), `dim` (fondo suave), `line` (borde), `glow1/glow2` (luz ambiental). Tiñe: navegación activa, botones primarios (gradiente acc→acc-deep), anillos, rieles de agenda, luz ambiental, logo, línea AHORA, burbujas salientes del chat.

| Acento | acc | acc-deep | acc-ink |
|---|---|---|---|
| Menta (fallback global) | #2DD4BF | #0D9488 | #04211C |
| Ártico | #7DD3FC | #0284C7 | #06222E |
| Índigo | #818CF8 | #4F46E5 | #0D0F2A |
| Lima | #A3E635 | #4D7C0F | #13210A |
| Oro | #E8C784 | #A97C33 | #1C1406 |
| Coral | #FB923C | #C2500C | #271103 |

(Los dim/line/glows exactos por modo están en el JS del artifact v11 — mapa `A{}`.)

**Default por país** (`Organization.country`, mapa en config editable sin deploy): CL→Menta · AR→Ártico · CO→Oro · MX→Lima · PE→Coral · resto→Índigo. El usuario lo cambia en sus preferencias (persistido por API).

## 4. Colores semánticos (independientes del acento del usuario)

- **Créditos/consumo** (anillo del Hoy, barra de facturación): gradiente del arco oscuro `#34D399 → #FBBF24 (55%) → #F87171`; claro `#0EA371 → #D97706 → #DC2626`. Porcentaje coloreado por tramo: **<60% verde · 60–85% ámbar · >85% rojo**.
- Estados de cita/chat: ok (confirmada/atendida) y warn (por confirmar/esperándote) con los tokens --m-ok/--m-warn. El color jamás es el único indicador (siempre texto).

## 5. Navegación unificada (misma en TODAS las pantallas)

- **Escritorio/tablet (≥620px)**: riel de iconos fijo izquierda 64px — logo arriba, Hoy · Conversaciones · Agenda · Clientes · Cobros, avatar del usuario abajo; tooltips. Nunca barra superior.
- **Móvil (<620px)**: el riel desaparece → **tab bar inferior** (Hoy · Chats con globo de pendientes · Agenda · Clientes · Más), blur + hairline superior. En chat abierto a pantalla completa, la tab bar se oculta.
- Conversaciones: lista 318px (compacta a 236px entre 620–980px); **el navegador SIEMPRE muestra dos paneles**; master-detail solo <620px.

## 6. Pantallas definidas (specs en maqueta v11)

**Hoy**: topbar (fecha+hora · "Asistente activo" con pulso · campana con punto · avatar) → saludo Fraunces con cursiva en el acento, **según hora del negocio** ("Buenos días" <12 · "Buenas tardes" 12–19:59 · "Buenas noches" ≥20) → 4 KPIs de vidrio (citas hoy · por confirmar (warn) · caja con sparkline del acento · conversaciones IA) → agenda del día (riel de acento por cita, pasadas al 55% opacidad, línea **"AHORA · hh:mm"** en el acento) + columna "Te esperan" y tarjeta de créditos con **anillo semántico** + proyección + botón sobre.

**Conversaciones** (patrón WhatsApp): lista con avatar 44px, nombre + último mensaje debajo (prefijo "Asistente:" + ticks dobles del acento cuando lo envió el bot; ícono del canal si no es WhatsApp), hora en warn + globo numerado cuando espera humano; filtros Todos/Esperándote/Con IA/No leídos. Chat: header (estado "IA atendiendo · responde sola", Ver ficha, Tomar conversación, buscar, ⋯) → **barra de operación** (chips: Agente IA ▾ · Asignada a ▾ · Etapa ▾ · +Etiqueta · píldora ventana 24h con tiempo restante) → hilo con fondo punteado --m-doodle, burbujas (entrantes --m-card izq / salientes acc-dim der, hora+ticks dentro), **eventos del bot como tarjetas** punteadas centradas, **notas internas** en warn punteado → fila "IA activa" con switch → composer píldora (adjuntar · respuestas rápidas · agendar · link de pago · nota) + enviar circular en el acento. Ficha del cliente: panel bajo demanda ("Ver ficha"), no fija.

**Patrones transversales**: hover de tarjetas con lift sutil; focus visible; chips interactivos con borde 1.5px que toma acc-line al hover; móvil mobile-first real (targets ≥44px); PWA instalable.

## 7. Reglas duras de implementación (resumen del F3)

1. El modo es solo tokens — un layout. 2. Acento = identidad del usuario; créditos = semáforo semántico, NUNCA del acento. 3. Saludo por hora con zona horaria del negocio. 4. Navegación idéntica en todas las pantallas (riel/tab bar). 5. `prefers-reduced-motion` apaga blobs y pulsos. 6. Prohibido importar de `apps/web` (lint). 7. Sin editor de agentes para el cliente ("Mi asistente" solo-lectura + solicitar cambio).
