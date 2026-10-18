# Validación final (pre-campaña) — Resultados · GO/NO-GO

**Fecha:** 2026-10-18 · **Pasada de cierre** (docs/PROMPT_VALIDACION_FINAL.md). Todo probado contra el **stack Docker** (`pnpm sim:up`), **nunca producción**. **TuBot intacto.** Regla aplicada: no se bajó ningún criterio — se ajustó el producto.

## Veredicto: 🟡 NO-GO (condicional)

El **núcleo está sólido y en verde** (plataforma, PWA, visual, robustez del asistente). Quedan **2 bloqueantes que dependen del dueño** antes de abrir la campaña:

1. **Evaluación de CALIDAD del asistente (F4)** — los 12 guiones + agente juez ≥ 90% requieren una **`ANTHROPIC_API_KEY` real** (IA real, no mock). No se pudo correr sin la clave. El arnés está listo (`tools/sim/assistant-eval.mjs`); la **robustez** y el **rate-limit** sí se verificaron (ver F4).
2. **Datos legales** — `apps/conversia-web/src/app/legal/_config.tsx` tiene `[RAZÓN SOCIAL — completar]`, `[RUT — completar]`, domicilio y comuna visibles en Términos y Privacidad públicos. Son tus datos legales reales; no se pueden inventar.

**Con esas dos cosas resueltas (F4 ≥ 90 % + legales cargados) → GO.** Todo lo demás de esta pasada está verde.

## Resultados por fase

| Fase | Resultado |
|---|---|
| **F1 — Regresión total (sim250 `all`, Docker)** | ✅ **Verde**: 0 crítico / 0 alto / 0 medio. 250 orgs · 8.118 msgs · 3.620 conversaciones. Dinero perfecto, dedupe wamid 10→1, fusible, free tier con costo, **frontera de marcas** (cross-brand 400×4 + pack), **sonda apex `conversia.cl` → marca conversia + 30 de regalo** (fix #506). |
| **F2 — PWA (Playwright + Lighthouse)** | ✅ **Verde**: Playwright **30/30 PWA** + **1/1 flujo** (móvil+escritorio, claro+oscuro). Instalable (manifest/SW/offline/aviso de versión). Lighthouse móvil: **`/crear` 92 · `/registro` 90** · A11y 100 · BP 100. Autenticadas (Web Vitals de laboratorio): **CLS 0** · LCP ~2,4–2,5 s. |
| **F3 — Pulido visual** | ✅ **Verde**: ~14 arreglos aplicados; **consola LIMPIA** (0 errores/warnings) en todas las rutas; sin scroll horizontal en 375px; tokens/copy es-CL. (PR visual #509.) |
| **F4 — Asistente de implementación** | 🟡 **Parcial**: robustez (IA caída → fallback, no 500) ✅ **corregida** (defecto encontrado y arreglado) · rate-limit 429 ✅. **Calidad (12 guiones + juez ≥90%) PENDIENTE de la clave de IA.** |
| **F5 — Cierre** | Entregable (este documento) + 4 PRs (#509 visual, #510 sim/tooling, #511 asistente, + doc). Re-corrida limpia de F1 queda al encender F4 con la clave. |

## Números

- **sim250 `all`** (F1): 0 crítico/alto/medio. Débitos de dinero exactos; dedupe 10→1; free tier sobre 1.000 con costo (24 de 3.634 envíos); 6 excepciones `saldo_gracia_sin_recarga` (esperado).
- **Lighthouse móvil** (F2): `/crear` **92**, `/registro` **90** (subió de 87 tras arreglar la grilla de rubros que era el LCP tardío), A11y **100**, BP **100**.
- **Web Vitals autenticadas** (F2, Playwright lab 4G): `/inicio` CLS **0** (antes 0.607), LCP ~2,5 s; `/conversaciones` CLS **0**, LCP ~2,4 s. *(Lighthouse CLI no inyecta la sesión de localStorage → se midieron las Web Vitals directamente.)*
- **F4 robustez**: IA caída → **201 + fallback claro** (antes 500); rate-limit **429** en el intento 21. **Juez de calidad: pendiente.**

## Ajustes visuales aplicados (F3) — antes/después

Capturas móviles (iPhone 13) antes (encargo PWA) y después (esta pasada) en el entorno Docker. Resumen de cambios:

| Pantalla | Antes | Después |
|---|---|---|
| Inicio | saldo "Cargando…" eterno en error; saludo saltaba (CLS 0.6) | error + reintentar; `suppressHydrationWarning`; **CLS 0** |
| Conversaciones | adjuntos `[image]`; nota con color hardcodeado | `[imagen]`/`[documento]`…; nota con token (color-mix) |
| Caja / Verify / Notificaciones | "webhook" / "token" / "(VAPID)" | "automático" / "enlace incompleto" / sin jerga |
| Cobros | estado `active`/`past_due` | "activa" / "pago pendiente" |
| Crear | "armado solo" bajo contraste (`--acc`) | `--acc-deep` |
| Registro | grilla de rubros crecía al cargar (LCP tardío) | fallback con los 14 → sin salto |
| Landing | nav sin tinte (color-mix sobre gradiente) | color sólido |
| Mini-sitio / Agenda·Config | error+spinner a la vez / falso "Sin recursos" | un solo estado / "Cargando…" |
| Asistente (burbuja) | `**markdown**` literal | render limpio |

## Transcripts del asistente (F4)

- **Robustez (IA caída):** entrada "hola, ¿qué me falta?" → *"Estoy teniendo un problema para responder en este momento 🙏. Reintenta en unos segundos… tu siguiente paso es: Conecta tu WhatsApp. Si sigue… escríbele a soporte."* (antes: 500).
- **Calidad (12 guiones + juez):** PENDIENTE — requiere la `ANTHROPIC_API_KEY`. El arnés (`tools/sim/assistant-eval.mjs`) corre los guiones (qué falta / conectar WhatsApp por coexistencia / error del popup de Meta / cobrar servicios por chat / saldo y recarga / método de pago / cambiar horario / derivar a humano / por rubro / cross-brand 404) y deja los transcripts para un agente juez con rúbrica.

## Pasos para Javier (para pasar a GO)

1. **`ANTHROPIC_API_KEY`** (gasto acotado): la paso al compose como variable local del contenedor `api` (gitignored, jamás commiteada) + `AI_PROVIDER=anthropic`, y corro F4 completo (12 guiones + juez). Si el juez da ≥ 90 % → GO de F4; si no, ajusto prompt/tools/copy y repito.
2. **Datos legales**: completar `apps/conversia-web/src/app/legal/_config.tsx` (razón social, RUT, domicilio, comuna) con los reales.
3. (Para producción, aparte de esta validación) claves **VAPID** de prod en Railway (ver `docs/APP_MOVIL_RESULTADOS.md`) y conexión real de canales (app Meta Conversia).

## Cómo reproducir
`pnpm sim:up` (stack completo: seed+golive+rate). Regresión de marca: `WEB_URL_CONVERSIA=https://app.conversia.cl` + `node tools/sim/sim250.mjs all` (en contenedor, ver `tools/sim/README.md`). PWA/visual: Playwright + Lighthouse contra `http://localhost:3002`.
