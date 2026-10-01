# CONVERSIA.CL — ANÁLISIS DE MERCADO Y ESTRUCTURA DE NEGOCIO DUAL

**Fecha:** 2026-09-30 (investigación web de esta fecha; precios con fuente)
**Modelo a validar:** dos marcas sobre la misma plataforma —
- **TuBot.cl** = autoservicio: el cliente configura sus propios bots. Barato. (Planes actuales: Free $0 / Starter $69.900 / Pro $119.900 CLP.)
- **Conversia.cl** = vertical llave en mano: el equipo técnico configura y entrega la plataforma lista y funcionando por rubro. Premium.

---

## 0. CONCLUSIONES PRINCIPALES

1. **El modelo "camaleónico" está validado a escala mundial**: GoHighLevel construyó un negocio enorme exactamente con este patrón (motor genérico + "snapshots" por vertical + agencias que venden done-for-you). La escalera Jobber (USD 69, autoservicio) → ServiceTitan (USD 400–900/técnico, implementado) demuestra que el mercado acepta **5–10x de diferencia de precio** cuando la versión premium incluye implementación y resultado.
2. **Ningún competidor horizontal LATAM vende un plan con precio por vertical** — la "verticalización" de Wati, Cliengo o SleekFlow es solo marketing (landings + plantillas). El done-for-you real es hoy territorio de agencias que no publican precios. **Conversia atacaría un hueco real: producto propio + servicio + precio publicado por vertical.**
3. **El mercado chileno ya paga la banda de Conversia**: servicio gestionado CLP 150.000–400.000/mes con setup de CLP 150.000–650.000 (agencias); AgendaPro vende su "empleado IA" (Charly) a **CLP 149.900/mes + IVA** sobre planes base de CLP 15.900–54.900; Dentipilot (IA sobre Dentalink) parte en CLP 299.990/mes. El ancla correcta de Conversia no es "otro software": es **el sueldo de una recepcionista** (marco a16z: el vertical SaaS con IA captura presupuesto de nómina, no de software).
4. **El pricing debe hacer imposible la comparación directa TuBot vs Conversia** (lección flanker brands + caso GHL): paquetes, unidades y nombres distintos. Si alguien puede armar la tabla "es lo mismo más caro", el modelo se canibaliza.
5. **La economía del done-for-you se decide en el costo de implantación, no en el software**: margen bruto SaaS puro ~79% vs ~70–75% high-touch. Regla de los casos estudiados: **sistematizar el alta ANTES de vender volumen** (el "paquete vertical" de `CONVERSIA_VERTICALES.md` es el equivalente del snapshot de GHL) y cobrar setup fee que cubra el costo real (GHL: USD 497–3.500).
6. **Amenaza nueva y concreta: Meta Business Agent** (global desde jun-2026, cobra USD 2/MTok desde ago-2026): responde FAQs, recomienda del catálogo y **agenda citas** nativo en WhatsApp. Canibaliza el bot básico — la defensa es todo lo que Meta no hace: CRM, agenda integrada al negocio, cobros, multiusuario, reportería, servicio local. Golpea más a TuBot (autoservicio) que a Conversia (servicio + admin del rubro).

---

## 1. PANORAMA COMPETITIVO

### 1.1 Horizontales WhatsApp+IA en LATAM (resumen; detalle de 16 players investigados)

| Banda | Players | Precio mensual | Nota |
|---|---|---|---|
| Entrada | ManyChat Pro, Tidio, Whaticket, Cliengo Starter | USD 24–49 | IA como add-on medido o inexistente |
| Media (donde vive TuBot) | Wati Growth/Pro, Cliengo Premium, Leadsales, B2Chat, Callbell, Simla | USD 69–150 | Casi todos cobran la IA aparte: Wati por respuesta, Tidio por conversación (Lyro hasta USD 700/1.000), ManyChat +USD 29, B2Chat +USD 80 |
| Alta | Botmaker, SleekFlow Premium, Respond.io Growth+, Zenvia, Treble | USD 149–499+ | Treble = el más "done-for-you" (sales-led, sin precio público); Kommo delega implementación a partners |

**Posición de TuBot:** Starter ~USD 73 / Pro ~USD 125 = exactamente la banda media. El diferenciador defendible no es precio: es **IA conversacional real incluida sin cupos mezquinos**, agenda nativa, catálogo y cobros — cosas que en la banda media son add-ons o no existen.

### 1.2 Verticales por rubro (los "sistemas de administración" contra los que Conversia compite o se compara)

**Belleza/barberías:**
- **AgendaPro** (Chile/LATAM — el comparable n.º 1): Individual CLP 15.900 → Pro CLP 249.900/mes; WhatsApp por cuotas (50 confirmaciones incluidas, extra CLP 5.000/50); **IA "Charly" desde CLP 149.900/mes + IVA**. Marketing 100% vertical ("Software para Peluquerías"). No tiene IA conversacional de atención en WhatsApp — su IA es de marketing/recuperación.
- **Fresha**: CLP 3.900–5.900/mes en Chile + WhatsApp CLP 65–315/mensaje + 20% comisión por cliente nuevo del marketplace (modelo EE.UU.). **Booksy**: USD 29,99 + USD 20/staff; 30% de la primera visita vía marketplace. **Boulevard** (premium EE.UU.): USD 176–421/local/mes con contrato anual. **Reservo** (Chile): sin precios públicos.
- **Lectura:** el admin de belleza es barato y commodity; nadie en Chile ofrece "recepcionista IA por WhatsApp integrada a la agenda" como producto central. Conversia Barbería no compite con AgendaPro por precio de agenda: vende lo que AgendaPro cobra CLP 149.900 extra — y con atención conversacional real.

**Dental/salud:**
- **Dentalink** (Chile): ficha clínica, desde ~USD 29/mes, precios completos no públicos. Terceros ya venden la capa IA sobre él: **Dentipilot desde CLP 299.990/mes** — validación directa del precio del vertical dental.
- EE.UU. como referencia de techo: **Weave** USD 300–500/mes/consulta, **NexHealth** desde ~USD 350/módulo, **Podium** USD 399–599 + AI Employee USD 99–399.
- **Lectura:** Conversia Dental = Cláriva (admin clínico) + recepcionista IA — combo que en Chile nadie más posee de punta a punta. Dentiqa, Kosmo (MXN 4.497/mes), Clientisima y Aurora Inbox ya pueblan el nicho: hay que moverse, pero nadie domina Chile.

**Servicios:**
- **Jobber** USD 69 (autoservicio) → **ServiceTitan** ~USD 398–900/técnico (implementado): la escalera de precio 5–10x que valida el spread TuBot→Conversia. Mismo producto, landings por oficio ("software para plomeros/electricistas") — el playbook de marketing vertical a copiar.

### 1.3 Tendencia "empleado IA" 2025–2026

Tres bandas de mercado: USD 30–100 (horizontal básico, ej. Goodcall 79–249), USD 100–400 (SMB integrado), **USD 400–1.000+ (vertical profundo: Slang.ai 399–599/local en restaurantes, Podium AI Employee, Weave)**. **La prima está en la verticalización**: el mismo motor se cobra 3–5x más cuando viene integrado al sistema del rubro y preconfigurado con sus flujos. AgendaPro Charly (CLP 149.900) es la versión chilena de esta prima. Ese es exactamente el espacio de precio de Conversia.

---

## 2. EL CASO GOHIGHLEVEL (el mapa del modelo)

- **Estructura:** plataforma horizontal USD 97–497/mes que se vende a agencias; las agencias la white-labelean y venden por nicho. "SaaS Mode" (USD 497) permite revenderla como software propio con rebilling.
- **Snapshots = paquetes verticales:** todo lo configurado (workflows, pipelines, plantillas, calendarios, campos) se empaqueta y se instala en cuentas nuevas en minutos. Regla del ecosistema: **2–5 snapshots maestros, uno por vertical; el snapshot "genérico" es peor que ninguno** (una dental y una empresa de techos comparten ~30% de la lógica). Existe un mercado de compraventa de snapshots por nicho.
- **Cómo cobran las agencias el done-for-you:** retainer USD 97–497/mes según nicho (dental 297–397) + **setup USD 497–997 (hasta 3.500)**; 3 tiers típicos.
- **Sus dolores (que Conversia hereda si no los diseña desde el día 1):** soporte intermediado ("lotería"), fiabilidad (automatizaciones que se caen sin aviso), **sorpresas de facturación por uso** (queja n.º 1), curva de aprendizaje (60–80% de agencias nuevas nunca la despliegan bien).
- **Traducción a Conversia:** el motor de paquetes verticales ES el snapshot; el alta asistida ES la agencia — pero con ventaja estructural: Conversia es dueña del software Y del servicio (sin intermediario que degrade soporte). Antídotos a copiar: cuotas de mensajes/IA claras por plan (nunca "a costo + sorpresa"), y paquete cerrado por vertical ("eso está disponible como add-on") contra el scope creep.

---

## 3. MODELO DOS MARCAS: LECCIONES Y REGLAS

**Casos:** EIG/Newfold (60+ marcas de hosting sobre el mismo backend — advertencia: cuando el soporte o la infraestructura fallan, caen todas las marcas a la vez); HighLevel (la marca madre es invisible para el cliente final — la distancia de marca total es lo que funciona); Fresha (migrar precios hacia arriba DENTRO de una marca anclada en "barato" es doloroso — argumento a favor de separar Conversia en vez de subir TuBot); Jobber/ServiceTitan (el mercado paga 5–10x por implementación + resultado).

**Marco (flanker brands):** una segunda marca se justifica solo si (a) los compradores son realmente distintos — dueño hazlo-tú-mismo sensible a precio vs dueño que delega todo —, (b) la brecha de precio es grande (3–10x) y (c) cada marca sostiene su propio marketing. "La mayoría de las peticiones de sub-marca son problemas de posicionamiento disfrazados" — Conversia NO debe ser "TuBot + setup" (eso sería un plan Premium de TuBot); debe ser un producto con interfaz, empaque y unidad de venta distintos. La decisión de interfaz nueva (`CONVERSIA_MONTAJE.md`) es coherente con esto.

**Reglas anti-canibalización:**
1. Tablas de precios **no comparables**: TuBot vende planes por features/límites; Conversia vende "tu recepcionista IA + sistema del rubro, funcionando" con setup + mensualidad. Unidades distintas, nombres distintos.
2. **Política de migración definida de antemano**: TuBot→Conversia (upsell natural, se acredita algo del historial); Conversia→TuBot (permitido pero pierde el servicio — evita que el churn de servicio sea churn de plataforma).
3. Asumir que **una caída golpea a ambas marcas**: el estado de salud (status page) y la comunicación de incidentes deben pensarse para dos marcas desde ya.
4. Cada marca con su propio embudo de marketing (el costo duplicado de marketing es real y hay que presupuestarlo — es el precio del modelo).

---

## 4. PRICING PRELIMINAR DE CONVERSIA (propuesta para discutir)

Anclas de mercado: recepcionista part-time en Chile ≈ CLP 350.000–500.000+/mes de nómina; servicio gestionado de agencia CLP 150.000–400.000/mes + setup CLP 150.000–650.000; AgendaPro Charly CLP 149.900 + IVA; Dentipilot CLP 299.990; banda internacional del empleado IA vertical USD 300–600.

| Componente | Propuesta | Racional |
|---|---|---|
| Setup / implementación | CLP 290.000–490.000 según vertical (pagadero una vez) | Cubre el costo real de implantación (COGS, no CAC); filtra curiosos; banda de agencia chilena pero con producto detrás |
| Mensualidad vertical | CLP 199.000–349.000 + IVA según vertical y sedes | 2,5–5x TuBot Pro: spread tipo Jobber→ServiceTitan; bajo el costo de nómina que reemplaza; sobre Charly porque incluye atención conversacional + admin |
| Cuotas incluidas | Mensajes de plantilla + conversaciones IA claramente definidos por plan; excedentes con precio publicado (rebilling con margen) | Antídoto a la queja n.º 1 de GHL; la bolsa prepagada ya existe en la plataforma |
| Permanencia | 6–12 meses en el tier con servicio (o setup con descuento amortizado) | Estándar del segmento premium (Boulevard, Podium); protege la economía del alta |
| Add-ons | Sede adicional, campañas/difusiones gestionadas, integraciones específicas | La frontera del scope: lo que no está en el paquete vertical se cotiza |

**Regla de viabilidad a vigilar:** utilidad bruta del cliente en el año 1 > costo de implantación. Con el motor de paquetes verticales + montaje asistido por IA, el costo marginal de alta baja con cada cliente del mismo vertical — esa es la ventaja compuesta del modelo.

---

## 5. COMPLICACIONES Y RIESGOS (consolidado)

1. **Costos WhatsApp en movimiento:** desde jul-2025 se cobra por mensaje de plantilla (Chile: marketing ~USD 0,089–0,102 — de los más caros de LATAM; utility ~USD 0,02). Desde **mañana 1-oct-2026** los mensajes de servicio dejan de ser ilimitados (1.000 gratis/mes por número, luego ~USD 0,02 en Chile) — el costo variable por tenant ya no es ~0 y debe estar dentro de las cuotas de los planes. La ventana de 72h de Click-to-WhatsApp sigue gratis → CTWA aún más estratégico en las campañas de ambas marcas.
2. **Meta Business Agent** (nativo, global jun-2026, USD 2/MTok): cubre el caso básico "responder y agendar". Presiona el segmento autoservicio; refuerza la tesis de que el valor está en el sistema completo del rubro + servicio.
3. **Comoditización:** 15+ horizontales, agencias locales "desde $25/mes", SaaS verticales nuevos en dental (Dentiqa, Kosmo, Clientisima, Aurora Inbox). La ventana para plantar la bandera "recepcionista IA + admin del rubro, en Chile, con precio publicado" es ahora.
4. **El servicio no escala solo:** margen high-touch 70–75% vs 79% SaaS puro; el tiempo del equipo configurando bots es COGS. Mitigación: paquete vertical ANTES de vender volumen + setup fee + montaje asistido por IA (ventaja única: el "técnico" de Conversia es en gran parte el propio agente de implementación con Opus).
5. **Scope creep:** paquete cerrado por vertical, extras como add-ons cotizados. El paquete ES el producto.
6. **Churn por servicio percibido:** en done-for-you el cliente compra "me funciona solo"; monitoreo de calidad de respuestas + revisión proactiva mensual del bot son parte del producto premium, no cortesía.
7. **Churn SMB de referencia:** 3–5% mensual global (sin benchmark LATAM publicado). El modelo Conversia (setup + configuración hecha + permanencia) es estructuralmente más resistente que el autoservicio.

---

## 6. ESTRUCTURA DE NEGOCIO DUAL (borrador para cerrar con Javier)

| | **TuBot.cl** | **Conversia.cl** |
|---|---|---|
| Cliente | Pyme hazlo-tú-mismo, sensible a precio | Dueño de negocio de nicho que delega; "quiero que funcione" |
| Producto | Plataforma completa, tú la configuras (con montaje asistido por bot) | Plataforma vertical llave en mano: equipo (humano + IA) configura, entrega y mantiene |
| Interfaz | Panel actual | App nueva por vertical (`apps/conversia-web`) |
| Precio | $0 / $69.900 / $119.900 (planes por features) | Setup + mensualidad por vertical (CLP ~199–349k), permanencia |
| Configuración de bots/agentes | El cliente (self-service) | **Solo el equipo técnico Conversia** — el editor de agentes no se expone al cliente (o solo lectura) |
| Margen | SaaS puro (~79%) | High-touch (~70–75%), compensado por ticket 3–5x y churn menor |
| Amenaza principal | Meta Business Agent + comoditización | Costo de implantación + calidad de servicio |
| Rol en el portafolio | Volumen, embudo de entrada, laboratorio de features | Ticket alto, caja estable, marca premium |

**Implicación técnica nueva** (se suma a `CONVERSIA_MONTAJE.md` §3): en las orgs `brand: 'conversia'`, el editor de agentes/flujos queda restringido por rol — el cliente ve resultados y métricas, no la configuración. El motor de permisos por rol ya existe; es política de producto, no desarrollo mayor.

**Preguntas abiertas para cerrar la estructura** (ver conversación): alcance del servicio continuo post-implantación, banda de precios definitiva, alcance geográfico inicial, y política de migración entre marcas.
