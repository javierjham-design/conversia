# Matriz de prueba funcional — Módulo de Flujos de trabajo

Generada en el Bloque 1 del endurecimiento de Flujos (2026-08-12). Cada fila se
prueba **ejecutando el motor de verdad** (no solo compilando) con `EngineDeps`
de grabación en sandbox. Evidencia = archivo::caso de test que la cubre.

**Suites verdes:** `@conversia/workflows` 38 tests · `@conversia/worker` 82 tests.
Arnés principal: `packages/workflows/src/harness.test.ts` (+ `engine.test.ts`) y
`apps/worker/src/http-node.test.ts`.

Leyenda estado: ✅ funcional y probado · ⚠️ parcial/brecha documentada ·
🕓 «Próximamente» (no ejecutable) · 🧪 solo verificable manualmente (efecto real).

---

## 1. Inventario de DISPARADORES

| Disparador | Estado | Condiciones probadas | Evidencia |
|---|---|---|---|
| `conversation_started` | ✅ | dispara por tipo; no dispara con otro evento | engine.test «hace match de triggers por tipo» |
| `message_received` | ✅ | canal, palabra **contiene** vs **exacto**, **cualquiera** vs **todas**, primer mensaje | engine.test «condiciones de message_received» |
| `conversation_closed` | ✅ | dispara al cerrar; no con message_received | engine.test «message_received y conversation_closed» |
| `keyword` (legado, oculto) | ✅ | contiene palabra; vacío = cualquiera | engine.test «message_received (…) legado» |
| `click_to_chat` | ✅ | anuncio específico, modo **seleccionados** (adIds/campaignIds), anuncio nuevo de campaña marcada, fuera de selección | engine.test «click_to_chat y lead_status_changed» |
| `lead_status_changed` | ✅ | origen→destino; destino distinto no dispara | engine.test idem |
| `tag_added` | ✅ | etiqueta específica (insensible a mayúsculas); vacío = cualquiera | engine.test «tag_added» |
| `appointment_created/confirmed/rescheduled/cancelled` | ✅ | filtros servicio/profesional/sede (Y lógico); vacío = todos | engine.test «filtros de triggers de cita» |
| `appointment_upcoming` | ✅ | `hoursBefore`; respeta horario (lógica en `appointment-reminders.test.ts`, 13 casos) | engine.test + worker appointment-reminders |
| `no_show` | ✅ | mismos filtros de cita | engine.test «filtros de cita» |
| `manual` | ✅ | ejecución directa (run-bulk / por id) | harness e2e #5/#6 |
| `missed_call` | 🕓 | marcado «Próximamente», no seleccionable (falta fuente del evento) | inventario |
| `tiktok_ad` | 🕓 | marcado «Próximamente» (falta canal TikTok) | inventario |

---

## 2. Inventario de PASOS × escenario

### Mensajería / Contacto / Conversación (escritura)
| Paso | Válido | Vacío | Inválido | Estado | Evidencia |
|---|---|---|---|---|---|
| `send_text` | renderiza `{{var}}` | envía cadena vacía | variable inexistente → «» | ✅ | harness «send_text renderiza…» |
| `send_template` | enruta con `templateId` | sin plantilla enruta igual (validación al publicar) | — | ✅ | harness «send_capi/send_template» |
| `update_lead_status` | cambia etapa | statusCode vacío enruta (worker no encuentra estado → no-op real) | — | ✅ | harness «pasos de escritura» |
| `add_tag` / `remove_tag` | etiqueta | — | — | ✅ | harness idem |
| `update_contact` | guarda campos | fields vacío → no-op | — | ✅ | harness idem |
| `assign_user` / `assign_team` | asigna (pausa IA) | — | — | ✅ | harness idem |
| `add_note` | comentario con variables | — | — | ✅ | harness idem |
| `close_conversation` | cierra | — | — | ✅ | harness idem |
| `open_conversation` | setea `conversationId` | — | — | ✅ | engine.test «abre conversación» |
| `transfer_human` | escala con motivo | sin motivo enruta | — | ✅ | harness «pasos de IA» |

### IA
| Paso | Escenario | Estado | Evidencia |
|---|---|---|---|
| `run_agent` | responde el agente elegido | ✅ | harness «pasos de IA» |
| `switch_agent` | cambia el agente activo | ✅ | engine.test «nodos nuevos» |
| `ai_objective` | **cumplido** (met) / **no cumplido** (unmet) / **multi-turno** (pending → wait + resume por rama) | ✅ | engine.test «ai_objective» + harness e2e #3/#6 |

### Control de flujo
| Paso | Escenario | Estado | Evidencia |
|---|---|---|---|
| `wait` | pausa y programa timer; reanuda tras timer | ✅ | engine.test «ejecuta hasta la espera» |
| `wait_reply` (nuevo) | espera respuesta → rama **replied**; timeout → rama **no_reply** | ✅ | harness «wait_reply» |
| `condition` (no_reply) | rama **true** (sin respuesta) y **false** (respondió); sin arista para la rama → termina sin colgarse | ✅ | harness «condition» + «condición sin arista» |
| `business_hours` | dentro/fuera/feriado; **default del negocio** si el nodo no trae horario | ✅ | engine.test «Fecha y hora» + harness «business_hours default» |
| `goto` | salta al destino, omite intermedios; corta bucles al superar 25 saltos | ✅ | engine.test «Saltar a otro paso» |
| `start_workflow` | dispara otro flujo por nombre (excluye auto-disparo) | ✅ | engine.test «nodos nuevos» |
| `stop` | termina la ejecución | ✅ | usado en todos los e2e |

### Integraciones
| Paso | Escenario | Estado | Evidencia |
|---|---|---|---|
| `call_api` | **200** (mapea JSON a variables) · **4xx** · **5xx** · **timeout/red** · **redirección** (bloqueada) · **SSRF** (bloquea IP interna/localhost/metadata, allowlist) · renderiza url/headers/body | ✅ | worker http-node.test (10 casos) + engine «Petición HTTP mapea variables» |
| `send_internal_email` | asunto/cuerpo con variables; destinatarios | ✅ | harness «pasos de integración» |
| `send_ga4_event` | encola evento con params | ✅ | harness idem |
| `google_sheets_append` | agrega fila con N columnas | ✅ | harness idem |

### Marketing / Agenda
| Paso | Escenario | Estado | Evidencia |
|---|---|---|---|
| `send_capi` | evento con/sin valor; no bloquea el flujo | ✅ | engine.test «send_capi» + harness |
| `send_tiktok_event` | 🕓 «Próximamente» (no-op explícito en el motor) | 🕓 | inventario |

---

## 3. Caminos completos (6 flujos e2e) — `harness.test.ts`
| # | Flujo | Resultado |
|---|---|---|
| 1 | Captación desde anuncio (open → tag → saludo → agente) | ✅ camino exacto verificado |
| 2 | Calificación con condición (mensaje → espera → sin respuesta → recordatorio) | ✅ espera + reanudación |
| 3 | Agendamiento con objetivo (met → etapa Agendado + CAPI; unmet → humano) | ✅ ambas ramas |
| 4 | Recordatorio con plantilla + confirmación (HSM → wait_reply → confirmó/no) | ✅ espera + rama replied |
| 5 | Reactivación de lead frío (mensaje → espera 3 días → 2º intento → etiqueta) | ✅ espera larga + reanudación |
| 6 | Derivación a agente + escalamiento (agente → objetivo unmet → humano) | ✅ camino de escalamiento |

## 4. Casos borde — `harness.test.ts`
| Caso | Resultado esperado | Estado |
|---|---|---|
| Arista a nodo inexistente | `failed` con el id faltante | ✅ |
| Paso que falla (efecto lanza) | `failed` + `nodeId` + step `FAILED` persistido | ✅ |
| Cadena > 50 nodos (tope por ejecución) | `failed` «Límite de nodos» | ✅ |
| Bucle con salto (`goto` a sí mismo) | `failed` «Límite de saltos» (25) | ✅ engine.test |
| Condición sin arista para la rama tomada | termina `completed` sin colgarse | ✅ |
| Variable inexistente / contacto sin datos | se renderiza como «» sin romper | ✅ |
| Nodo huérfano / referencias rotas / mensaje vacío | bloquea la **publicación** con problemas por nodo | ✅ engine.test «validación al publicar» |

---

## 5. Lo que NO se puede probar automáticamente (por qué) — 🧪
Estos efectos tocan servicios externos o la BD real; el motor está probado con
dobles, y su ejecución real se valida en el **probador interactivo** (sandbox,
sin efectos) y/o manualmente en un tenant:
- **Envío real por WhatsApp** (texto y plantilla HSM) — requiere WABA de producción con nombre aprobado; hoy Digital Dent está en número de prueba. Cubierto por el gate de mensajería (5 capas) y el probador «lo que haría».
- **CAPI / GA4 / correo** llegando al proveedor — se encolan y reintentan; el envío real se verifica en Events Manager / GA4 DebugView.
- **Escrituras en BD** (lead, etiqueta, cita) — el probador las muestra como «simuladas»; la persistencia real la cubren los tests de integración por módulo.
- **Concurrencia real del mismo flujo+contacto** — la idempotencia del run está por `(workflowId, conversación/contacto, tipo)` en `dispatchEvent`; verificable en historial de ejecuciones (Bloque 4, pendiente).

---

## 6. Hallazgos del inventario y correcciones
| Hallazgo | Acción |
|---|---|
| `business_hours`: mi test asumía jueves; 2026-08-12 es **miércoles** | Corregido el test (bug del test, no del motor). |
| `call_api`: **timeout/4xx/5xx/redirección** sin cobertura explícita | Añadidos 5 casos a `http-node.test.ts`. |
| `wait_reply` (nodo nuevo de ayer) sin tests | Añadida cobertura de ambas ramas (replied/no_reply). |
| `NODE_CATALOG` del servidor (`workflows.controller.ts`) **desactualizado** (usa `condition_no_reply`, faltan ~15 pasos) y **el editor no lo consume** (usa su `NODE_DEFS` cliente) | Brecha documentada; se limpiará en el bloque de disparadores/estética para evitar confusión (no afecta al usuario hoy). |
| `pause_ai` / `resume_ai`: soportados por el motor y en `NODE_TYPES`, **no ofrecidos** en el editor | Brecha documentada (hoy se logra con transfer_human/assign). Evaluar exponerlos. |
| Tipos reservados en `NODE_TYPES` sin ejecutor ni tarjeta (`send_media`, `classify_intent`, `extract_data`, `summarize`, `check_availability`, `create_appointment`, `confirm_appointment`, `cancel_appointment`, `branch`, `cancel_workflows`, `send_webhook`, `notify_team`) | **No se ofrecen** al usuario (no aparecen en el menú), por lo que no hay nada roto; quedan como nombres reservados. Documentado. |
| Rama de error explícita en pasos que pueden fallar (HTTP/plantilla/agenda) | **Brecha real** → Bloque 5 (política de errores por paso). Hoy `call_api` expone `__http_ok`/`__http_status` como variables pero el editor aún no permite ramificar por ellas. |

---

## 7. Brechas abiertas (honestas) → bloques siguientes
- **Bloque 2** — Probador paso a paso sobre el canvas (resaltado del nodo en curso, inspector de variables antes/después, contacto de prueba editable, inyección de eventos). Base ya existente: `workflow-live-sim.ts` (ejecuta motor + IA real en sandbox, sin efectos).
- **Bloque 4** — Observabilidad: historial de ejecuciones (los datos ya existen en `workflow_runs` + `workflow_run_steps`; falta la UI y métricas). Sin migración nueva.
- **Bloque 5** — Política de errores por paso (reintentos/continuar/detener), rama de error, timeout global, notificación por fallos repetidos.
- **Bloques 3/6/7** — Vista previa/prueba de disparadores y detección de conflictos; estética del canvas (iconos por familia, color por categoría, minimapa/auto-organizar/atajos, nodo deshabilitado); galería de plantillas y estado vacío.
