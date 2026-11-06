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

- **Escritorio/tablet (≥768px)**: riel fijo izquierda **214px con icono + NOMBRE**, agrupado en tres bloques con título (*Día a día* · *Tu negocio* · *Tu cuenta Conversia*) — logo arriba (enlace al inicio), cerrar sesión abajo. Nunca barra superior.
  > **Corrección del dueño (3-nov-2026).** Esto decía "riel de iconos 64px … tooltips". La maqueta v11 tenía CINCO destinos; el producto llegó a NUEVE, y nueve iconos mudos no se leen: *"no se sabe bien a qué menú se está accediendo"*. Peor, cuatro secciones (Caja, Clientes, Mi página web, Ajustes) no se enlazan desde ninguna otra pantalla, así que un riel que no se entiende las esconde. Un tooltip no sirve: hay que apuntar y esperar, y en táctil no existe. **No volver a iconos solos**; si hace falta recortar, se recortan destinos, no nombres. Los nombres y los grupos salen de `apps/conversia-web/src/lib/nav.ts`, que es también de donde cada pantalla saca su título (ver §5bis).
- **Móvil (<768px)**: el riel desaparece → **tab bar inferior** (los 4 de *Día a día*: Hoy · Conversaciones · Agenda · Clientes) + **Más**, que abre una hoja con el resto, con los MISMOS títulos de grupo y fondo sólido. En chat abierto a pantalla completa, la tab bar se oculta.
- Conversaciones: lista 340px, **compacta a 248px bajo 1100px** (el riel con nombres ocupa 214px, no 68); **el navegador SIEMPRE muestra dos paneles**; master-detail solo <768px. Los tres quiebres (riel, tabs y master-detail) son el MISMO: 768px.

## 5bis. El nombre de una sección se escribe UNA vez

`lib/nav.ts` es la única tabla: de ella salen el menú, el título de cada pantalla (componente `EncabezadoSeccion`) y las pestañas. Una pantalla **no escribe su `<h1>`**: pide `<EncabezadoSeccion ruta="/caja" />`. Así el texto del menú y el de la pantalla no pueden divergir — el menú llegó a decir "Mi página" y la pantalla "Tu página web", a un clic de distancia.

- **Pestañas** (`nav.pestanas`) cuando una sección tiene más de una pantalla (Agenda: Calendario · Configurar). Reemplazan la flecha de "volver".
- **Índice** (`nav.indice`) en pantallas largas (Cobros, Ajustes): enlaces a secciones de la MISMA página. **Nunca pestañas que esconden contenido**: Convi resalta por `data-copilot` y su acción `navigate` solo acepta rutas exactas, sin query (`apps/api/src/assistant/actions.ts`), así que un elemento dentro de una pestaña cerrada lo dejaría fallando en silencio.
- Los grupos del menú no son decoración: separan **Caja** (el dinero del negocio del dueño) de **Cobros** (lo que Conversia le cobra a él). Antes eso se aclaraba con un paréntesis dentro de la pantalla de Caja. La palabra "Cobros" no se renombra: es la que Convi usa de viva voz con el cliente.

Lo encierra `apps/conversia-web/src/lib/nav.test.ts` y, en navegador, `e2e/como-el-dueno/jornada-i-se-donde-estoy.spec.ts`.

## 5ter. Convi tiene que notarse (y no tapar nada)

Convi es quien saca al cliente del 0%: si no se entiende que está ahí, el montaje se abandona. Hasta el 6-nov-2026 su única presencia era una carita de 56px flotando abajo a la derecha, **sin una sola palabra** — el mismo acertijo que eran los nueve iconos mudos del menú (§5).

- **En el flujo de "Hoy"**: tarjeta `ConviCartel` con el monito levantando un cartel, la pancarta, el avance y el botón. Solo en MODO MONTAJE; desaparece sola al llegar al 100%, no se cierra a mano. Va **en el flujo** y no flotando porque una barra fija abajo SIEMPRE tapa algo (ver `nada-tapa-la-barra.test.ts`): ahí puede ser todo lo grande que haga falta.
- **El acceso flotante** lleva el avatar **y las palabras** mientras quede montaje (pancarta + "Paso N de M"); terminado el montaje vuelve a ser el círculo discreto de siempre.
- **El dibujo**: `ConviAvatar` acepta `pancarta`, que dibuja el cartel vacío. Las PALABRAS van siempre en HTML al lado, nunca en un `<text>` del SVG (a tamaño de burbuja mide 5px, no lo lee un lector de pantalla y no se puede cambiar sin tocar el dibujo).
- Los textos salen de `cartelDeConvi()` en `lib/convi.ts` — una sola función para la tarjeta y para el acceso, para que no digan cosas distintas del mismo montaje.
- **Panel acoplado desde 1100px**, no desde 768: el riel con nombres ocupa 214px y el panel 404, así que en una tablet de 800px al contenido le quedaban 182px. Entre 768 y 1099 el panel se superpone.
- Cuando Convi **resalta algo que no está en pantalla**, lo dice con palabras y con el nombre que esa pantalla tiene en el menú (`dondeEsta()`); antes el resaltado fallido no dejaba rastro de ningún tipo.

## 5quater. Orden de apilado: en teléfono, la barra de abajo manda

En un teléfono la barra de pestañas **es el menú entero**. Que nada la tape se vigila por dos vías, y hacen falta las dos:

1. **Distancia** — nada fijo se apoya dentro de sus 62px.
2. **Apilado** — lo que flota va *por debajo* de ella, así que si alguna vez se rozan, el toque sigue siendo del menú.

Con solo la distancia esto se rompió **tres veces**: el aviso PWA (que acabó yendo en el flujo), la burbuja de Convi y su acceso. Cada arreglo subía el `bottom` del estorbo de turno — 70, 78, 86 — y el problema volvía por otro lado. La distancia es una tregua; el orden es una garantía.

| Capa | z-index | Puede tapar la barra |
|---|---|---|
| Acceso flotante de Convi | 40 | no |
| Burbuja (peek) de Convi | 41 | no |
| **Barra de pestañas** (`.shell-tabs`) | **45** | — |
| Velo + hoja "Más" | 46 / 47 | sí: *es* el menú |
| Velo + menú de la barra de operación | 49 / 50 | sí |
| Chat de Convi abierto | 50 | sí: ocupa la pantalla a propósito |
| Modales con velo, aviso de cookies | 60 | sí |

Regla para lo nuevo: **un aviso va por debajo de 45; una hoja que el dueño abrió a propósito, por encima de 46.** Lo ata `nada-tapa-la-barra.test.ts`, que además comprueba que supo leer cada valor (un guardián que no encuentra el número se pone rojo, no verde).

## 6. Pantallas definidas (specs en maqueta v11)

**Hoy**: topbar (fecha+hora · "Asistente activo" con pulso · campana con punto · avatar) → saludo Fraunces con cursiva en el acento, **según hora del negocio** ("Buenos días" <12 · "Buenas tardes" 12–19:59 · "Buenas noches" ≥20) → 4 KPIs de vidrio (citas hoy · por confirmar (warn) · caja con sparkline del acento · conversaciones IA) → agenda del día (riel de acento por cita, pasadas al 55% opacidad, línea **"AHORA · hh:mm"** en el acento) + columna "Te esperan" y tarjeta de créditos con **anillo semántico** + proyección + botón sobre.

**Conversaciones** (patrón WhatsApp): lista con avatar 44px, nombre + último mensaje debajo (prefijo "Asistente:" + ticks dobles del acento cuando lo envió el bot; ícono del canal si no es WhatsApp), hora en warn + globo numerado cuando espera humano; filtros Todos/Esperándote/Con IA/No leídos. Chat: header (estado "IA atendiendo · responde sola", Ver ficha, Tomar conversación, buscar, ⋯) → **barra de operación** (chips: Agente IA ▾ · Asignada a ▾ · Etapa ▾ · +Etiqueta · píldora ventana 24h con tiempo restante) → hilo con fondo punteado --m-doodle, burbujas (entrantes --m-card izq / salientes acc-dim der, hora+ticks dentro), **eventos del bot como tarjetas** punteadas centradas, **notas internas** en warn punteado → fila "IA activa" con switch → composer píldora (adjuntar · respuestas rápidas · agendar · link de pago · nota) + enviar circular en el acento. Ficha del cliente: panel bajo demanda ("Ver ficha"), no fija.

**Patrones transversales**: hover de tarjetas con lift sutil; focus visible; chips interactivos con borde 1.5px que toma acc-line al hover; móvil mobile-first real (targets ≥44px); PWA instalable.

## 7. Reglas duras de implementación (resumen del F3)

1. El modo es solo tokens — un layout. 2. Acento = identidad del usuario; créditos = semáforo semántico, NUNCA del acento. 3. Saludo por hora con zona horaria del negocio. 4. Navegación idéntica en todas las pantallas (riel/tab bar), **con el nombre de cada destino escrito** y sacado de `lib/nav.ts` (§5 y §5bis). 5. `prefers-reduced-motion` apaga blobs y pulsos. 6. Prohibido importar de `apps/web` (lint). 7. Sin editor de agentes para el cliente ("Mi asistente" solo-lectura + solicitar cambio).
