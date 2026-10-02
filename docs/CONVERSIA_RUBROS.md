# CONVERSIA — CATÁLOGO MAESTRO DE RUBROS (ranking + bases por vertical)

**Fecha:** 2026-10-02 (investigación web de esta fecha: mercado Chile/LATAM + evidencia mundial de disposición a pagar)
**Para qué:** alimentar directamente `industries.ts` y las `vertical_templates` (etapas F2/F6 de PROMPTS_CONVERSIA.md). Los rubros de olas 2–3 se cargan como plantillas desde ya aunque su marketing se active después.
**En desarrollo (ola 1, definida por Javier):** barbería, peluquería, centro de estética, centro médico, clínica dental + módulo genérico.

---

## 0. CONCLUSIONES DEL CRUCE (Chile/LATAM × evidencia mundial)

1. **La disposición a pagar está probada en dos capas**: en EE.UU. los negocios locales pagan USD 150–700/mes por el software de su rubro Y ADEMÁS USD 250–2.100/mes por que alguien conteste (Ruby/Smith.ai; capa IA: Slang $399–599/local, Avoca $1.000–3.500). Conversia vende ambas capas juntas a USD 160–320: el pitch correcto es **"recepcionista IA + cobros" contra el costo de la llamada/lead perdido**, no "software de gestión".
2. **ICP transversal (emerge de los datos)**: (a) 3+ profesionales/recursos agendables, (b) ticket ≥$25.000 o planes multi-sesión, (c) ya invierte en Meta Ads o paga algún software ($15–70k/mes), (d) el dueño atiende el WhatsApp. Donde se cumplen las 4, $150–300k/mes se justifica solo (recepcionista part-time cuesta $350–500k+).
3. **Las joyas que el instinto no ve**: veterinarias (3.200 locales CL, recurrencia natural, software vertical débil → espacio abierto), kinesiología (el paciente va 2–3 veces/semana: nadie le saca más valor a un bot de confirmación) y servicios a domicilio con 3+ técnicos (el rubro n.º 1 del mundo en pagar IA: ServiceTitan $961M revenue + Avoca unicornio).
4. **Falsas joyas**: restaurantes (dolor real pero el producto correcto es POS/pedidos — Toteat/Fudo ya lo tienen; solo sirve el segmento con reserva como variante), servicios técnicos unipersonales (no pagan $150k), belleza masiva de precio bajo (Fresha/Booksy los acostumbraron a $5–30k/mes — por eso barbería/peluquería se vende por VALOR: señas anti no-show + re-reserva, no por agenda).
5. **No-show es el número que vende**: 16,5–21,8% en salud Chile (público), 15–25% en belleza; recordatorios bajan de 20,3% a 12,5% (U. de Chile). Una cita de $40k recuperada por semana ya paga medio plan.
6. **Donde el rubro paga caro, paga por tres cosas** (patrón mundial): (a) no perder llamadas/leads, (b) llenar la agenda (anti no-show/recall), (c) cobrar sin fricción. Y como los rubros top compran software ($150–500) + recepcionista ($250–2.100) por separado, queda espacio para un **tier premium futuro >USD 320 con IA de voz** — anotado para el roadmap de planes.

---

## 1. RANKING MAESTRO (26 rubros evaluados)

Score 1–5: 💰 capacidad de pago · 🎯 facilidad de venta (dolor + decisor único + densidad) · 🔁 recurrencia del cliente final · ⚙️ fit con la plataforma hoy.

### OLA 1 — en desarrollo (base validada)

| Rubro | 💰 | 🎯 | 🔁 | ⚙️ | Evidencia clave |
|---|---|---|---|---|---|
| Clínica dental | 5 | 4 | 4 | 5 | Weave ~USD 500/local real; IA dental USD 700–1.400; caso propio Digital-Dent + Cláriva/Dentalink |
| Centro de estética | 4 | 5 | 5 | 5 | AgendaPro Serie B US$35M sobre este rubro; gasto belleza CL +48% en 2 años |
| Centro médico | 5 | 4 | 4 | 5 | No-show 16,5–21,8% medible; Medilink/Reservo ya les cobran |
| Barbería | 3 | 4 | 5 | 5 | Alta densidad y recurrencia (corte cada 3–4 semanas); vender por señas + re-reserva, no por agenda |
| Peluquería | 3 | 4 | 5 | 5 | Ídem barbería; Fresha/Booksy validan adopción masiva (precio bajo → pitch de valor) |

### OLA 2 — construir plantillas AHORA, lanzar tras los pilotos (orden recomendado)

| # | Rubro | 💰 | 🎯 | 🔁 | ⚙️ | Por qué |
|---|---|---|---|---|---|---|
| 1 | **Medicina estética avanzada / medspa** (láser, botox, armonización) | 5 | 5 | 5 | 5 | El mejor de todos: planes de 6–10 sesiones (re-agenda forzada), tickets $300k–1,5M, botox +55% demanda, gastan fuerte en Meta Ads (sinergia CAPI), ya educados por AgendaPro. Mundial: Boulevard $800M / Zenoti $1,5B sostienen USD 300–600/local. Separarlo de "estética" como segmento premium propio |
| 2 | **Veterinarias (+ peluquería canina)** | 4 | 5 | 5 | 5 | 3.200 locales CL, 12M mascotas, mercado US$2.500M; vacunas/controles/grooming = recordatorios perfectos; software vertical débil y barato → ser el primero en "WhatsApp vet". Mundial: Shepherd $299+, Otto $48M levantados |
| 3 | **Kinesiología / rehabilitación** | 3,5 | 4 | 5 | 5 | Paciente 2–3 veces/semana; abandono de tratamiento = packs de $100–400k perdidos; Encuadrado probó que el rubro paga SaaS |
| 4 | **Gimnasios boutique / studios** (yoga, pilates, crossfit) | 4 | 4 | 5 | 4 | 2.100 gimnasios CL (+72% en 5 años); ya pagan GymPlus $35–135k; cupos por clase + cobro mensual recurrente (brilla el módulo cobros). Falta fino: reserva de cupos grupales (hoy la agenda es 1-a-1 → nota técnica abajo) |
| 5 | **Talleres mecánicos / servitecas** | 4 | 4 | 3 | 4 | 12.590 empresas SII, parque de 6M vehículos; "¿está listo mi auto?" + presupuestos sin responder; AutoSoft les cobra $13–40k (pagan). Mundial: Tekmetric/Shopmonkey USD 200–500 flat + Numa (IA, $48M). Killer: bot de estado de orden de trabajo |
| 6 | **Servicios a domicilio — empresas 3+ técnicos** (clima/HVAC, instalaciones, eléctricos) | 4 | 3,5 | 2,5 | 4 | El n.º 1 mundial en pagar IA (ServiceTitan $961M, Avoca ~$1B, Jobber→ServiceTitan 5–10x): cada llamada perdida es un trabajo de $300k+. En CL atacar SOLO empresas con cuadrillas (el unipersonal no paga) |
| 7 | **Centros de psicología / salud mental** (5+ terapeutas) | 3,5 | 4 | 5 | 5 | Sesión semanal + cobro anticipado anti no-show; Encuadrado construyó su negocio aquí. Solo centros: al profesional solo tu precio no le calza |

### OLA 3 — plantillas listas, activar según demanda

| # | Rubro | 💰 | 🎯 | 🔁 | Nota |
|---|---|---|---|---|---|
| 8 | Implante capilar / cirugía estética | 5 | 4 | 2 | LTV gigante ($1,8–4,6M/paciente), CPL $20–50k: el bot-SDR que responde en 30 seg se paga con 1 lead/año. Pocas cuentas → venta consultiva |
| 9 | Escuelas de conducir / academias con clase práctica | 3,5 | 4 | 4 | Agendamiento 1-a-1 intensivo + matrícula $150–400k cerrada por WhatsApp; sin vertical dominante (whitespace) |
| 10 | Corretaje inmobiliario | 4 | 3,5 | 2 | Enorme (52.123 SII) y speed-to-lead probado (FUB/Structurely), pero exige VARIANTE de producto: bot calificador + agenda de visitas, sin recurrencia |
| 11 | Alojamiento boutique / cabañas / moteles | 3,5 | 3 | 2,5 | 5.116 registrados SERNATUR; disponibilidad 24/7 por WhatsApp + señas; Cloudbeds caro y en USD. Sin channel manager (limitación honesta) |
| 12 | Spa / masajes | 3 | 4 | 4 | Extensión casi gratis del paquete estética |
| 13 | Tatuajes / piercing | 3 | 4 | 2,5 | Hora bloqueada 3–6h: la seña por bot es EL gancho; extensión del paquete barbería. Techo de precio: plan Funcionando |
| 14 | Restaurantes con reserva (segmento medio-alto) | 3 | 3 | 3,5 | Slang sostiene USD 399–599 solo por contestar; en CL solo el segmento con reserva/eventos (variante "mesas", no citas). El resto del rubro: genérico o nunca |
| 15 | Abogados / estudios jurídicos | 4 | 3 | 2 | La señal de pago más pura del mundo (Ruby/Smith.ai $250–2.100/mes por contestar; Clio $5B) — variante intake/calificación de casos |
| 16 | Ópticas | 3 | 3 | 2,5 | 1.687 locales, boom de aperturas; "sus lentes están listos" + recompra anual; sin vertical CL |
| 17 | Control de plagas / sanitización | 3,5 | 3 | 4 | Servicio recurrente con autopago (FieldRoutes comprada en US$577M); mercado CL chico pero fiel |
| 18 | Lavanderías con retiro/entrega | 3 | 3 | 4 | Cents levantó $140M (2026) sobre esta industria; pickup/delivery por WhatsApp es copia directa; ticket bajo → plan Funcionando |

### GENÉRICO (no justifican vertical propio a este precio)
Florerías, mudanzas/fletes, limpieza de hogares, banquetería, fotografía/eventos, servicios técnicos unipersonales, contadores, farmacias, comida rápida/delivery (ya resuelto por apps). El módulo genérico los atiende; si un segmento muestra tracción, se promueve a vertical.

---

## 2. BASES POR RUBRO PARA LA PLATAFORMA

Formato por rubro: vocabulario (cliente · servicio · profesional · cita · local) → módulos → embudo → flujos v1 → HSM clave → específico del rubro → KPIs del "Hoy". Lo transversal a TODOS (ya definido en PROMPTS_CONVERSIA.md): reseña Google post-atención, recuperación CTWA 72h, informe semanal al dueño, señas por link de pago, re-reserva cíclica donde aplique.

### Ola 1 (complementos a lo ya en desarrollo)

**`barberia`** — cliente · corte/servicio · barbero · hora · local. Módulos: agenda+cobros+catálogo(productos). Embudo: Nuevo→Agendado→Atendido→Recurrente→Inactivo 45d. Flujos: recordatorio+confirmación · re-reserva cíclica (21–28d) · no-show con seña para reincidentes · lista de espera. HSM: recordatorio, "se liberó una hora", reactivación. Específico: venta de pomadas/productos en el chat; walk-in vs reserva. KPIs: citas hoy, por confirmar, caja, ocupación por silla.
**`peluqueria`** — ídem barbería con: servicios largos (coloración 2–4h) → seña obligatoria sugerida; recordatorio de retoque (6–8 semanas); ficha técnica de color en notas del cliente.
**`estetica`** (gabinete/depilación/faciales) — clienta · tratamiento · esteticista · sesión · centro. Flujos: plan multi-sesión (ver medspa) light · recordatorio de siguiente sesión · gift cards (v2). Específico: contraindicaciones en ficha; fotos antes/después en notas.
**`centro_medico`** — paciente · prestación · profesional · hora · centro. Módulos: agenda+cobros; integración Cláriva/Medilink si existe. Flujos: confirmación 48h+24h · lista de espera por sobredemanda · recall de controles. Específico: triage básico (urgencia→humano), copago/seña, bono/previsión en campos custom. KPIs: no-show semanal (el número que vende).
**`dental`** — paciente · tratamiento · dentista · hora · clínica. Todo lo de centro médico + presupuestos no aceptados (seguimiento a los X días) · post-operatorio automático · recall higiene 6 meses · abonos de tratamiento por link. Sistema clínico: Cláriva/Dentalink.

### Ola 2 (bases completas para construir plantillas ya)

**`medspa`** (medicina estética avanzada) — paciente · tratamiento/plan · profesional · sesión · clínica.
- Módulos: agenda+cobros+catálogo(planes)+difusiones. Embudo: Lead Ads→Evaluación agendada→Evaluó→Compró plan→En tratamiento→Completó→Reactivable.
- Flujos v1: lead de Meta respondido <1 min con calificación (zona a tratar, presupuesto) · agenda de evaluación · **plan multi-sesión**: tras cada sesión, agenda automática de la siguiente + recordatorio; alerta al dueño si el plan se estanca · seña/abono por link para reservar plan · reactivación post-plan (mantención anual).
- HSM: recordatorio de sesión N de M, "tu plan quedó pausado, ¿retomamos?", promo de temporada (difusión).
- Específico: consentimientos y contraindicaciones en ficha; fotos de avance; precios por zona en catálogo. KPIs: sesiones hoy, planes activos, planes estancados, caja.

**`veterinaria`** — tutor (del paciente mascota) · atención/servicio · veterinario · hora · clínica.
- Módulos: agenda+cobros+catálogo(alimentos/fármacos). Embudo: Nuevo→Agendado→Atendido→Plan sanitario→Inactivo.
- Flujos v1: **carnet sanitario**: recordatorio de vacuna anual y desparasitación por mascota · grooming cíclico (4–6 semanas) · post-cirugía (control a 7 días) · recompra de alimento (ciclo según kg/bolsa).
- HSM: "a {{mascota}} le toca su vacuna", recordatorio de hora, retiro de alimento.
- Específico: el CONTACTO es el tutor pero la ficha gira en torno a la(s) MASCOTA(s) → campos custom: nombre, especie, raza, fecha nacimiento, peso (multi-mascota por contacto). Urgencias → humano de inmediato. KPIs: atenciones hoy, vacunas por vencer esta semana, grooming agendados, caja.

**`kinesiologia`** — paciente · sesión/tratamiento · kinesiólogo · sesión · centro.
- Módulos: agenda+cobros. Embudo: Derivado→Evaluación→En tratamiento (N/M sesiones)→Alta→Reactivable.
- Flujos v1: confirmación DIARIA de la sesión de mañana · **anti-abandono**: si falta a 1 sesión, reagenda inmediata; si falta a 2, alerta al dueño · pack de sesiones con abono por link · recordatorio de ejercicios post-sesión (texto del kine).
- Específico: packs 6–20 sesiones con contador visible en ficha; orden médica como adjunto; convenios/isapres en campos custom. KPIs: sesiones hoy, pacientes en riesgo de abandono, packs por cerrar.

**`gimnasio`** (boutique/studio) — alumno · clase/plan · coach · cupo/clase · sede.
- Módulos: agenda(clases)+cobros(membresías)+difusiones. Embudo: Lead→Clase de prueba→Matriculado→Activo→En riesgo (sin asistir 10d)→Inactivo.
- Flujos v1: clase de prueba desde Ads con confirmación · **cobro mensual de membresía** con reintento y aviso · "te extrañamos" al caer asistencia · lista de espera de cupos.
- NOTA TÉCNICA (brecha conocida): la agenda nativa es 1-a-1; las **clases grupales con cupos** requieren extensión del modelo (capacity por slot) — incluirla en la plantilla como requisito para F4+ antes de activar el vertical.
- KPIs: clases de hoy con ocupación, membresías por vencer, en riesgo, caja.

**`taller`** (mecánico/serviteca) — cliente · trabajo/servicio · mecánico/bahía · cita/orden · taller.
- Módulos: agenda(bahías como recursos)+cobros+catálogo(servicios estándar). Embudo: Cotización→Agendado→En taller→Listo para retiro→Entregado→Mantención programada.
- Flujos v1: **estado de la orden** ("tu auto está en diagnóstico / listo para retiro") actualizado desde el panel con 1 toque · pre-cotización por foto/patente (humano aprueba) · recordatorio de mantención por km/fecha (campo: patente, próximo mantenimiento) · seña para repuestos caros.
- HSM: "tu vehículo está listo", recordatorio de mantención de los 10.000 km.
- Específico: la PATENTE es la llave de la ficha (multi-vehículo por cliente). KPIs: autos en taller por estado, retiros de hoy, cotizaciones sin responder, caja.

**`servicios_domicilio`** (clima/instalaciones/eléctricos con cuadrillas) — cliente · trabajo · técnico/cuadrilla · visita · zona.
- Módulos: agenda(técnicos como recursos)+cobros. Embudo: Lead→Visita agendada→Cotizado→Aprobado→Ejecutado→Garantía.
- Flujos v1: calificación del lead (comuna → validar cobertura, tipo de trabajo, urgencia) · pre-cotización por foto (humano aprueba) · anticipo por link · "el técnico va en camino" · post-servicio con garantía y reseña.
- Específico: dirección + comuna obligatorias; ventanas horarias (9–13 / 14–18); urgencias con recargo. KPIs: visitas de hoy por técnico, cotizaciones pendientes de aprobar, caja.

**`psicologia`** (centros multi-terapeuta) — paciente/consultante · sesión · terapeuta · sesión · centro.
- Módulos: agenda+cobros. Flujos v1: **sesión semanal recurrente** (mismo día/hora, agenda en bloque) · cobro anticipado al agendar (anti no-show del rubro) · confirmación 24h con reagendo fácil · alerta de pausa de tratamiento.
- Específico: tono del bot sobrio y confidencial; CERO contenido clínico por chat (solo logística); telepresencial con link de videollamada en la cita; derivación a línea de crisis en el prompt (seguridad). KPIs: sesiones hoy, pagadas vs pendientes, pacientes pausados.

### Ola 3 (bases abreviadas — suficientes para sembrar la plantilla v1)

**`implante_capilar`**: lead Ads→evaluación (presencial o foto)→presupuesto→cirugía→post-op 12 meses con hitos de foto. Bot-SDR <1 min, financiamiento en campos custom, seguimiento post-op largo. KPI: leads respondidos <1 min, evaluaciones agendadas.
**`escuela_conducir`**: alumno · clase práctica · instructor · clase · sede. Matrícula por WhatsApp con link de pago, agenda intensiva de prácticas, recordatorio de examen, paquetes de clases con contador.
**`corretaje`** (variante lead-qualifier): lead portal/Ads→calificado (presupuesto, comuna, pre-aprobación)→visita agendada→oferta→cierre. Sin recurrencia; difusión de nuevas propiedades a interesados compatibles.
**`alojamiento`**: huésped · estadía · habitación/cabaña (recurso) · reserva · propiedad. Disponibilidad por fechas (agenda por recurso-noche: usar citas de día completo), seña 30–50% por link, check-in instructivo, upsell (tina, late checkout). Limitación declarada: sin channel manager.
**`spa`**: clona `estetica` con vocabulario propio y gift cards.
**`tatuajes`**: clona `barberia` + seña OBLIGATORIA al agendar (hora bloqueada 3–6h), brief de diseño por fotos, cuidado post-tatuaje automático.
**`restaurante_reservas`** (variante mesas): comensal · reserva · mesa (recurso) · servicio (almuerzo/cena). Reserva con confirmación mismo día, no-show con seña para grupos 6+, eventos/banquetería como cotización. NO pedidos/delivery (fuera de alcance).
**`abogados`** (variante intake): consultante · causa/consulta · abogado · reunión. Calificación del caso (materia, urgencia, comuna) → agenda de primera consulta PAGADA por link (filtra curiosos). Tono formal; confidencialidad en prompt.
**`optica`**: cliente · examen/producto · tecnólogo · hora · local. "Tus lentes están listos" + recompra anual + recordatorio de control; catálogo de marcos v2.
**`control_plagas`**: cliente · servicio · técnico · visita · zona. Servicio recurrente (trimestral/semestral) con autopago y certificado post-servicio adjunto.
**`lavanderia`**: cliente · pedido · repartidor · retiro/entrega · local. Variante pedidos: retiro agendado, aviso "listo", entrega, suscripción semanal. Plan Funcionando.

---

## 3. INSTRUCCIÓN DE INCORPORACIÓN AL DESARROLLO (para F2/F6)

1. `industries.ts`: sembrar las claves de TODOS los rubros de este catálogo (olas 1–3) con su vocabulario — es barato y deja el selector de rubro completo desde el día 1. Los de ola 3 pueden compartir plantilla base con overrides.
2. `vertical_templates`: v1 completas para ola 1 + ola 2 (prioridad del seed en ese orden); ola 3 como plantillas "beta" (instalables por el equipo desde la consola F10, no expuestas en el registro público hasta activarlas).
3. Variantes de producto que NO son "citas" y requieren diseño propio antes de activarse: `corretaje` (lead-qualifier), `restaurante_reservas` (mesas), `abogados` (intake), `alojamiento` (recurso-noche), `lavanderia` (pedidos). Marcarlas en la plantilla con `variant: "leads"|"mesas"|"intake"|"estadias"|"pedidos"` para que la UI del paquete lo sepa.
4. Brechas técnicas que algunos rubros exigen (añadir a la cola post-F4): **clases grupales con cupos** (gimnasio), multi-entidad por contacto (mascotas en veterinaria, vehículos en taller → modelar como campos custom repetibles o tabla ligera), estado de orden de trabajo con 1 toque (taller).
5. Marketing: landings por vertical solo para ola 1 + medspa/veterinaria/kinesiología al inicio; el resto se vende por el agente comercial con el selector completo.

## 4. Fuentes
Los dos informes de respaldo (Chile/LATAM con SII, gremios y software local; y benchmarks mundiales con precios oct-2026 de 40+ verticales: Toast, Weave, ServiceTitan, Avoca, Slang, Boulevard, Shepherd, Clio, Smith.ai, etc.) quedaron citados con URLs en la conversación de planificación del 2026-10-02. Anclas duras: Toast ARPU SaaS ~USD 510/local (filings), Weave ~USD 500/local, ServiceTitan USD 961M FY26, AgendaPro Serie B US$35M, no-show salud CL 16,5–21,8% (Medwave/BMC/U. de Chile).
