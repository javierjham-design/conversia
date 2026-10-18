# PROMPT DE DESARROLLO — VALIDACIÓN FINAL EN DOCKER: plataforma + app móvil + visual + ASISTENTE DE IMPLEMENTACIÓN

**Para el desarrollador (Claude Code en VS Code, con agentes). Docker listo.** Esta es la
pasada de CIERRE antes de la campaña: una corrida grande que lo vea TODO junto — la
plataforma completa en Docker, la app móvil (PWA), el pulido visual, y una evaluación a
fondo del **Asistente de la plataforma**: debe poder acompañar el proceso de
implementación COMPLETO de un cliente nuevo, y toda la experiencia debe quedar
**extremadamente intuitiva**. Veredicto final GO/NO-GO con evidencia.

Contexto: la lógica ya está validada (sims 40/200/250 + seguridad 16/16 + carga +
frontera de marcas en PRs #506/#507 — verifica que estén mergeados y haz `git pull`).
No repitas análisis: EJECUTA las suites existentes y profundiza donde se indica.

---

## F1 — REGRESIÓN TOTAL EN DOCKER (la base de todo lo demás)

1. Levanta el stack completo con `docker-compose.sim.yml` (M6.1) + seed + golive +
   `whatsappRateSchedule` + smoke gate. Config de producción endurecida (rol
   `conversia_app` + DIRECT admin, providers mock para WhatsApp).
2. Corre `tools/sim/sim250.mjs all` — TODO debe quedar en verde, incluidas las pruebas
   nuevas de frontera de marcas (`sec-cross-brand-plan` 400×4, `sec-cross-brand-pack`)
   y la de familia de dominio: registra una sonda con Origin `https://conversia.cl`
   (apex) y verifica que nace **marca conversia** con regalo 30 (fix #506).
3. Corre la fase de carga (w8/metrics si existen del encargo 2) y la carga de push.
4. Cualquier rojo: causa raíz → fix + test → re-corrida completa. Nada se "anota para
   después".

## F2 — APP MÓVIL (PWA) COMPLETA

1. Ejecuta la suite Playwright (M5) completa — móvil (iPhone/Pixel) y desktop, claro y
   oscuro — contra el stack Docker. Verde obligatorio.
2. **Instalación real**: PWA instalable verificada (manifest, SW, offline, aviso de
   versión nueva); flujo de instalación guiada visible y claro en móvil e iOS
   (instrucciones de Añadir a pantalla de inicio).
3. **Push**: suscripción desde Ajustes → push con la app cerrada → clic abre la
   conversación correcta (mock de push del M6.3); preferencias por tipo respetadas.
4. **Lighthouse móvil** ≥ 90 (Performance/Accesibilidad/Best Practices) en /inicio,
   /conversaciones, /crear y /registro — adjunta los reportes.
5. Teclado móvil: el composer de la Bandeja no salta ni tapa el input; formularios con
   inputMode correcto; sin scroll horizontal en 375px en NINGUNA pantalla.

## F3 — PULIDO VISUAL ("extremadamente bien y ajustado")

Pasada heurística pantalla por pantalla (las 12+ rutas del panel + landing + /crear +
/registro + mini-landing), en móvil y desktop, claro y oscuro. Para cada pantalla
verifica y AJUSTA donde falle:

- **Estados completos**: cargando (skeleton, no spinners eternos), vacío (con CTA útil,
  no un hueco), error (mensaje accionable + reintentar — patrón del fix de /crear),
  éxito. Cero "Cargando…" sin salida.
- **Consistencia Nocturna**: tokens de color (nada hardcodeado), tipografía, radios,
  espaciado 4/8; el acento del usuario aplicado en todos lados; contraste AA en ambos
  temas; selector de rubros (chips ≤8 / desplegable >8) coherente en /crear y /registro.
- **Jerarquía e intuición**: en cada pantalla, la acción principal es OBVIA en 3
  segundos; textos en el español de la marca (sin jerga técnica, sin anglicismos de
  developer); números con formato es-CL.
- **Consola del navegador LIMPIA** en todas las rutas (cero errores, cero warnings de
  React/hidratación).
- Entregable: tabla pantalla × hallazgos × ajuste aplicado, con capturas antes/después
  de lo que cambies. Cambios de UI solo aditivos/visuales — la lógica ya está validada.

## F4 — EL ASISTENTE DE IMPLEMENTACIÓN (la estrella de esta pasada)

El Asistente in-app es el implementador virtual: un cliente nuevo debe poder llegar a
"negocio operando" SOLO conversando con él. Evalúalo con IA REAL, no mock:

1. **Entorno**: en el compose, levanta la API con `ANTHROPIC_API_KEY` de prueba (gasto
   acotado: límite de turnos por guion, modelo configurado del asistente). Todo lo demás
   sigue mock. JAMÁS la clave en un commit.
2. **Banco de guiones** (mínimo 12, como usuarios reales que NO saben de tecnología;
   cada guion = conversación de varios turnos):
   - "¿Qué me falta para empezar?" → debe liderar con el checklist real (verEstado) y
     proponer el siguiente paso concreto.
   - "¿Cómo conecto mi WhatsApp? tengo el número en mi teléfono" → debe explicar la
     coexistencia (QR, no pierde sus chats) y llevar a /canales.
   - "Me salió: tu navegador bloqueó la ventana de Meta" → ayuda específica del popup
     (el botón "Pedir ayuda al asistente" de Canales debe pasarle el error como contexto
     y la respuesta debe ser ESPECÍFICA, no genérica).
   - "Quiero cobrar $15.000 el corte y $25.000 la barba" → gestiona servicios por chat
     (tools de escritura, confirmación antes de aplicar, verificar en BD el cambio).
   - "¿Cuántas conversaciones me quedan?" / "se me están acabando" → saldo real +
     ofrecerRecarga con el link correcto.
   - "¿Cómo cargo mi tarjeta?" → paso de método de pago del checklist.
   - "Cambia el horario del local a 10-20" (modo dueño) → resumen de impacto +
     confirmación explícita antes de ejecutar.
   - "¿Me pueden ayudar por teléfono?" / frustración → deriva a humano/soporte con
     gracia (y queda el rastro para tu equipo).
   - Un guion por cada rubro distinto (gimnasio, abogados, dental…) preguntando algo
     del negocio → las respuestas usan el contexto del rubro instalado.
   - Cliente TuBot intentando usarlo → 404 limpio en API y SIN burbuja visible en la UI.
3. **Evaluación automatizada**: guarda los transcripts y haz que un agente JUEZ los
   califique contra una rúbrica (¿respondió lo correcto?, ¿accionó la tool correcta?,
   ¿tono claro y cercano?, ¿cero inventos de precios/datos?, ¿propuso el siguiente
   paso?). Criterio: **≥ 90 % de los checks en verde**; todo fallo → ajuste de prompt
   del asistente / tools / copy → re-evaluación.
4. **Robustez**: IA caída o lenta (simula 500/timeout del provider) → el asistente
   responde el fallback claro, NUNCA queda mudo ni rompe la página; rate limit 20/5min
   verificado con mensaje amable.
5. **Proactividad**: con un error de canal reciente (integrationEvent error), el
   contexto del asistente lo trae y la burbuja lo ofrece ("vi que falló tu conexión…").
6. **Intuición de la burbuja**: visible sin estorbar en móvil y desktop; se abre con
   contexto de la ruta actual; historial del hilo se conserva en la sesión; accesible
   (foco, Escape cierra, lector de pantalla).

## F5 — CIERRE

1. Re-corrida completa (F1 + F2 + suites) tras todos los ajustes. TODO verde.
2. Entregable: `docs/VALIDACION_FINAL_RESULTADOS.md` con: resumen ejecutivo GO/NO-GO,
   tabla de resultados por fase, los números (Lighthouse, carga, % del juez del
   asistente), ajustes visuales aplicados (antes/después), transcripts destacados del
   asistente (el mejor y el peor con su fix), y los pasos que quedan para Javier si los
   hay (p. ej. ANTHROPIC_API_KEY definitiva, prueba en su teléfono físico).
3. PRs por bloque (visual / asistente / fixes), CI verde, descripciones con evidencia.

## Proceso con agentes

1. Agente INFRA (F1.1) → tú corres la regresión (F1.2–1.4).
2. En paralelo: Agente PWA (F2), Agente VISUAL (F3), Agente ASISTENTE (F4: guiones +
   juez). Contratos primero si tocan tipos.
3. Agentes de FIX por hallazgo; re-corrida final tuya (F5).

## Reglas duras

- TuBot intacto (regresiones del harness en verde; cero cambios de su comportamiento).
- Nada contra producción; la clave de IA solo como variable local del compose.
- Cambios de lógica de negocio: SOLO si un test rojo lo exige, con causa raíz.
- Prohibido bajar un criterio para que pase: se ajusta el producto, no la vara.
