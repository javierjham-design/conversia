#!/usr/bin/env node
/**
 * BUILDER del catálogo de plantillas verticales (F2/F6, fuente: docs/CONVERSIA_RUBROS.md).
 * Genera packages/database/seeds/vertical-templates.json desde datos compactos por rubro
 * (reduce repetición y errores en ~18 rubros). El JSON sigue siendo el seed que leen los
 * loaders y los seeders. Correr: `node scripts/build-vertical-templates.mjs`.
 *
 * Versionado: ola 1 => v3 (enriquecida sobre las v1/v2 previas); ola 2/3 => v1. El
 * instalador toma la mayor versión activa por key.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Embudo estándar (la mayoría de los rubros de citas lo comparten).
const FUNNEL = (firstName = "Nuevo") => [
  { code: "nuevo", name: firstName, category: "OPEN", order: 0 },
  { code: "contactado", name: "Contactado", category: "OPEN", order: 1 },
  { code: "agendado", name: "Agendado", category: "OPEN", order: 2 },
  { code: "atendido", name: "Atendido", category: "WON", order: 3 },
  { code: "perdido", name: "No concretó", category: "LOST", order: 4 },
];
const HOURS_STD = { mon: ["09:00-19:00"], tue: ["09:00-19:00"], wed: ["09:00-19:00"], thu: ["09:00-19:00"], fri: ["09:00-19:00"], sat: ["10:00-14:00"], sun: [] };
const bienvenida = (text) => ({
  templateKey: "bienvenida",
  name: "Bienvenida",
  description: "Saluda y ofrece ayudar en el primer mensaje.",
  definition: { nodes: [{ id: "start", type: "trigger", config: { event: "message_received" } }, { id: "welcome", type: "send_text", config: { text } }], edges: [{ from: "start", to: "welcome" }] },
});

// Prefijo común de tono para todos los prompts de recepción.
const TONE = "Atiendes por WhatsApp de forma cálida, clara y breve (2-3 frases, una pregunta a la vez, en un solo mensaje). Agendas y respondes dudas de servicios y precios SOLO con la información de tus herramientas; si no la tienes, lo reconoces y ofreces que una persona del equipo continúe. Nunca inventes precios, horarios ni disponibilidad.";

// ---- Rubros. `v` = versión; `wave`,`status`,`variant`,`req` (requiresFeature). ----
const R = [
  // ===== OLA 1 (v3, full) =====
  { key: "generico", v: 3, wave: 1, status: "active", variant: "citas", industry: "generico", emoji: "✨", tagline: "Configuración general lista para adaptar",
    hours: { mon: ["09:00-18:00"], tue: ["09:00-18:00"], wed: ["09:00-18:00"], thu: ["09:00-18:00"], fri: ["09:00-18:00"], sat: [], sun: [] },
    services: [{ code: "consulta", name: "Consulta inicial", category: "general", durationMin: 30, price: 0 }, { code: "atencion", name: "Atención estándar", category: "general", durationMin: 45, price: 0 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }, { name: "Frecuente", color: "#16a34a" }],
    kpis: ["citas_hoy", "por_confirmar", "caja_hoy"],
    greeting: "¡Hola! 😊 Gracias por escribir. ¿En qué te puedo ayudar hoy?",
    prompt: "Eres la recepción del negocio. " + TONE,
    faq: [{ title: "Cómo atendemos", content: "Atendemos y coordinamos por WhatsApp. Cuéntanos qué necesitas y te ayudamos a agendar o resolver tu consulta." }] },

  { key: "dental", v: 3, wave: 1, status: "active", variant: "citas", industry: "dental", emoji: "🦷", tagline: "Odontología y consultas dentales",
    hours: { mon: ["09:00-13:00", "15:00-19:00"], tue: ["09:00-13:00", "15:00-19:00"], wed: ["09:00-13:00", "15:00-19:00"], thu: ["09:00-13:00", "15:00-19:00"], fri: ["09:00-14:00"], sat: [], sun: [] },
    funnel: FUNNEL("Nuevo paciente"),
    services: [{ code: "consulta", name: "Consulta / evaluación", category: "diagnostico", durationMin: 30, price: 0 }, { code: "limpieza", name: "Limpieza dental", category: "preventiva", durationMin: 45, price: 35000 }, { code: "tapadura", name: "Tapadura (obturación)", category: "operatoria", durationMin: 45, price: 40000 }, { code: "ortodoncia-eval", name: "Evaluación de ortodoncia", category: "ortodoncia", durationMin: 40, price: 0 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }, { name: "Urgencia", color: "#dc2626" }, { name: "Ortodoncia", color: "#7c3aed" }],
    customFields: [{ key: "prevision", label: "Previsión / seguro" }],
    kpis: ["citas_hoy", "no_show_semana", "presupuestos_pendientes", "caja_hoy"],
    flows: ["recordatorio+confirmación 48h/24h", "recall higiene 6 meses", "seguimiento de presupuesto no aceptado", "post-operatorio automático"],
    hsm: ["recordatorio de cita", "recall de control", "tu presupuesto sigue disponible"],
    greeting: "¡Hola! 😊 Gracias por escribir a la clínica. ¿Te gustaría agendar una evaluación o tienes alguna consulta?",
    prompt: "Eres la recepción de una clínica dental. " + TONE + " Trata a quien escribe como paciente. URGENCIA: ante dolor fuerte, sangrado o golpe reciente, deriva de inmediato a una persona del equipo (transferToHuman) y ofrece la hora más próxima — no hagas triage clínico por chat.",
    faq: [{ title: "Primera consulta", content: "En la primera consulta evaluamos tu caso y te explicamos opciones y presupuesto. Trae documento de identidad y, si tienes, radiografías previas." }, { title: "Urgencias", content: "Si tienes dolor intenso, sangrado o un golpe reciente, avísanos: priorizamos tu atención." }] },

  { key: "centro_medico", v: 3, wave: 1, status: "active", variant: "citas", industry: "centro_medico", emoji: "🩺", tagline: "Consultas y especialidades médicas",
    hours: { mon: ["08:30-13:00", "14:30-19:00"], tue: ["08:30-13:00", "14:30-19:00"], wed: ["08:30-13:00", "14:30-19:00"], thu: ["08:30-13:00", "14:30-19:00"], fri: ["08:30-14:00"], sat: ["09:00-13:00"], sun: [] },
    funnel: FUNNEL("Nuevo paciente"),
    services: [{ code: "consulta-general", name: "Consulta médica general", category: "consulta", durationMin: 30, price: 25000 }, { code: "consulta-especialidad", name: "Consulta de especialidad", category: "consulta", durationMin: 30, price: 35000 }, { code: "control", name: "Control", category: "consulta", durationMin: 20, price: 20000 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }, { name: "Control", color: "#16a34a" }, { name: "Convenio/seguro", color: "#7c3aed" }],
    customFields: [{ key: "prevision", label: "Previsión / bono" }],
    kpis: ["citas_hoy", "no_show_semana", "por_confirmar", "caja_hoy"],
    flows: ["confirmación 48h+24h", "lista de espera por sobredemanda", "recall de controles"],
    hsm: ["recordatorio de hora", "recall de control"],
    greeting: "¡Hola! 😊 Gracias por escribir. ¿Deseas agendar una hora? Cuéntame la especialidad o el motivo y te ayudo.",
    prompt: "Eres la recepción de un centro médico. " + TONE + " Trata a quien escribe como paciente. NO entregas diagnósticos ni indicaciones clínicas: ante síntomas recomiendas agendar; ante señales de gravedad (dolor en el pecho, dificultad para respirar, sangrado abundante) deriva de inmediato a una persona (transferToHuman) y sugiere acudir a urgencias.",
    faq: [{ title: "Agendar una hora", content: "Indícanos la especialidad o el motivo y tu disponibilidad; te ofrecemos las horas más cercanas." }, { title: "Urgencias", content: "Este canal es para agendar y consultas administrativas. Ante una urgencia médica, acude al servicio de urgencias más cercano." }] },

  { key: "estetica", v: 3, wave: 1, status: "active", variant: "citas", industry: "estetica", emoji: "🌿", tagline: "Faciales, corporales y depilación",
    hours: HOURS_STD, funnel: FUNNEL("Nuevo cliente"),
    services: [{ code: "evaluacion", name: "Evaluación / diagnóstico de piel", category: "diagnostico", durationMin: 30, price: 0 }, { code: "limpieza-facial", name: "Limpieza facial profunda", category: "facial", durationMin: 60, price: 30000 }, { code: "depilacion-laser", name: "Depilación láser (zona)", category: "depilacion", durationMin: 30, price: 25000 }, { code: "masaje", name: "Masaje reductor / relajante", category: "corporal", durationMin: 60, price: 28000 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }, { name: "Paquete/plan", color: "#7c3aed" }, { name: "Seguimiento", color: "#16a34a" }],
    customFields: [{ key: "contraindicaciones", label: "Contraindicaciones" }],
    kpis: ["sesiones_hoy", "planes_activos", "por_confirmar", "caja_hoy"],
    flows: ["plan multi-sesión light", "recordatorio de siguiente sesión", "reseña post-atención"],
    hsm: ["recordatorio de sesión", "tu plan te espera"],
    greeting: "¡Hola! 🌿 ¿Buscas agendar un tratamiento? Cuéntame qué te interesa y te ayudo con la evaluación o la sesión.",
    prompt: "Atiendes un centro de estética. " + TONE + " Para tratamientos por zonas o planes, indica que el plan y el valor final se confirman en una evaluación. No das indicaciones médicas; ante dudas de salud sugieres evaluación presencial.",
    faq: [{ title: "Evaluación previa", content: "Para varios tratamientos recomendamos una evaluación inicial: así definimos el plan y el valor según tu caso." }] },

  { key: "barberia", v: 3, wave: 1, status: "active", variant: "citas", industry: "barberia", emoji: "💈", tagline: "Cortes, barba y combos",
    hours: { mon: ["10:00-20:00"], tue: ["10:00-20:00"], wed: ["10:00-20:00"], thu: ["10:00-20:00"], fri: ["10:00-21:00"], sat: ["10:00-18:00"], sun: [] },
    funnel: FUNNEL("Nuevo cliente"),
    services: [{ code: "corte", name: "Corte de pelo", category: "corte", durationMin: 30, price: 10000 }, { code: "barba", name: "Perfilado de barba", category: "barba", durationMin: 20, price: 7000 }, { code: "corte-barba", name: "Corte + barba", category: "combo", durationMin: 45, price: 15000 }],
    tags: [{ name: "Cliente nuevo", color: "#2563eb" }, { name: "Frecuente", color: "#16a34a" }, { name: "Combo", color: "#d97706" }],
    kpis: ["citas_hoy", "por_confirmar", "ocupacion_silla", "caja_hoy"],
    flows: ["recordatorio+confirmación", "re-reserva cíclica 21-28d", "no-show con seña para reincidentes", "lista de espera"],
    hsm: ["recordatorio", "se liberó una hora", "reactivación"],
    greeting: "¡Hola! 💈 ¿Quieres reservar una hora? Dime qué servicio (corte, barba o combo) y para cuándo.",
    prompt: "Atiendes una barbería. " + TONE + " Confirma con qué barbero y a qué hora. Puedes ofrecer productos (pomadas) si te preguntan.",
    faq: [{ title: "Reservas", content: "Reservas por WhatsApp. Dinos el servicio y el día/horario que prefieres y te confirmamos con un barbero." }] },

  { key: "peluqueria", v: 3, wave: 1, status: "active", variant: "citas", industry: "peluqueria", emoji: "✂️", tagline: "Corte, color, peinado y tratamientos",
    hours: { mon: ["10:00-19:00"], tue: ["10:00-19:00"], wed: ["10:00-19:00"], thu: ["10:00-20:00"], fri: ["10:00-20:00"], sat: ["10:00-18:00"], sun: [] },
    funnel: FUNNEL("Nuevo cliente"),
    services: [{ code: "corte-mujer", name: "Corte mujer", category: "corte", durationMin: 45, price: 15000 }, { code: "corte-hombre", name: "Corte hombre", category: "corte", durationMin: 30, price: 10000 }, { code: "tintura", name: "Tintura / color", category: "color", durationMin: 120, price: 35000 }, { code: "tratamiento", name: "Tratamiento capilar", category: "tratamiento", durationMin: 60, price: 25000 }],
    tags: [{ name: "Cliente nuevo", color: "#2563eb" }, { name: "Color", color: "#db2777" }, { name: "Frecuente", color: "#16a34a" }],
    customFields: [{ key: "ficha_color", label: "Ficha técnica de color" }],
    kpis: ["citas_hoy", "por_confirmar", "caja_hoy"],
    flows: ["seña obligatoria en servicios largos", "recordatorio de retoque 6-8 semanas", "re-reserva cíclica"],
    hsm: ["recordatorio", "te toca tu retoque"],
    greeting: "¡Hola! ✨ ¿Te gustaría reservar una hora? Cuéntame qué servicio buscas (corte, color, peinado…) y para cuándo.",
    prompt: "Atiendes una peluquería. " + TONE + " Para color o tratamientos, avisa que el valor final puede variar según el largo del cabello y se confirma en el local; en servicios largos sugiere seña.",
    faq: [{ title: "Color y tratamientos", content: "El valor de color y tratamientos puede variar según el largo y estado del cabello; lo confirmamos al evaluarte." }] },

  // ===== OLA 2 (v1) — top-3 full, resto base =====
  { key: "medspa", v: 1, wave: 2, status: "active", variant: "citas", industry: "medspa", emoji: "💉", tagline: "Medicina estética: láser, botox, armonización",
    hours: HOURS_STD, funnel: [{ code: "lead", name: "Lead Ads", category: "OPEN", order: 0 }, { code: "evaluacion", name: "Evaluación agendada", category: "OPEN", order: 1 }, { code: "evaluo", name: "Evaluó", category: "OPEN", order: 2 }, { code: "compro_plan", name: "Compró plan", category: "WON", order: 3 }, { code: "en_tratamiento", name: "En tratamiento", category: "WON", order: 4 }, { code: "completo", name: "Completó", category: "WON", order: 5 }, { code: "perdido", name: "No concretó", category: "LOST", order: 6 }],
    services: [{ code: "evaluacion", name: "Evaluación médica", category: "diagnostico", durationMin: 30, price: 0 }, { code: "botox", name: "Toxina botulínica (zona)", category: "inyectable", durationMin: 30, price: 150000 }, { code: "laser", name: "Sesión láser (zona)", category: "laser", durationMin: 40, price: 80000 }],
    tags: [{ name: "Lead Ads", color: "#2563eb" }, { name: "Plan activo", color: "#16a34a" }, { name: "Plan estancado", color: "#d97706" }],
    customFields: [{ key: "zona", label: "Zona a tratar" }, { key: "presupuesto", label: "Presupuesto" }, { key: "consentimiento", label: "Consentimiento" }],
    kpis: ["sesiones_hoy", "planes_activos", "planes_estancados", "caja_hoy"],
    flows: ["lead de Meta respondido <1 min con calificación (zona, presupuesto)", "plan multi-sesión: agenda la siguiente tras cada sesión + alerta si se estanca", "seña/abono por link", "reactivación post-plan"],
    hsm: ["recordatorio de sesión N de M", "tu plan quedó pausado, ¿retomamos?", "promo de temporada"],
    greeting: "¡Hola! Gracias por tu interés 💉 Para orientarte mejor, ¿qué zona o tratamiento te gustaría y tienes un presupuesto en mente?",
    prompt: "Atiendes una clínica de medicina estética. " + TONE + " Antes de agendar la evaluación, CALIFICA el lead: pregunta zona a tratar y presupuesto aproximado. Los precios por zona salen del catálogo; el plan final lo define el profesional en la evaluación. Maneja consentimientos y contraindicaciones como datos de ficha, sin dar indicaciones médicas por chat.",
    faq: [{ title: "Cómo funciona", content: "Primero una evaluación médica para definir el plan y el valor por zona. Varios tratamientos se hacen en planes de varias sesiones." }] },

  { key: "veterinaria", v: 1, wave: 2, status: "active", variant: "citas", industry: "veterinaria", emoji: "🐾", tagline: "Consultas, vacunas y peluquería canina",
    hours: HOURS_STD, funnel: [{ code: "nuevo", name: "Nuevo", category: "OPEN", order: 0 }, { code: "agendado", name: "Agendado", category: "OPEN", order: 1 }, { code: "atendido", name: "Atendido", category: "WON", order: 2 }, { code: "plan_sanitario", name: "Plan sanitario", category: "WON", order: 3 }, { code: "inactivo", name: "Inactivo", category: "LOST", order: 4 }],
    services: [{ code: "consulta", name: "Consulta veterinaria", category: "consulta", durationMin: 30, price: 20000 }, { code: "vacuna", name: "Vacunación", category: "preventiva", durationMin: 20, price: 15000 }, { code: "grooming", name: "Peluquería / grooming", category: "estetica", durationMin: 60, price: 20000 }],
    tags: [{ name: "Nuevo", color: "#2563eb" }, { name: "Plan sanitario", color: "#16a34a" }, { name: "Grooming", color: "#d97706" }],
    customEntities: { mascotas: { label: "Mascotas", fields: ["nombre", "especie", "raza", "fecha_nacimiento", "peso"], repeatable: true } },
    kpis: ["atenciones_hoy", "vacunas_por_vencer", "grooming_agendados", "caja_hoy"],
    flows: ["carnet sanitario: recordatorio de vacuna anual y desparasitación por mascota", "grooming cíclico 4-6 semanas", "post-cirugía control a 7 días", "recompra de alimento por ciclo"],
    hsm: ["a {{mascota}} le toca su vacuna", "recordatorio de hora", "retiro de alimento"],
    greeting: "¡Hola! 🐾 ¿En qué podemos ayudar a tu mascota? Cuéntame su nombre y qué necesita (consulta, vacuna o peluquería).",
    prompt: "Atiendes una veterinaria. El CONTACTO es el tutor, pero la ficha gira en torno a la(s) MASCOTA(s): pregunta y registra nombre, especie, raza y edad. " + TONE + " Urgencias (accidente, intoxicación, dificultad para respirar) → deriva de inmediato a una persona (transferToHuman).",
    faq: [{ title: "Vacunas y controles", content: "Llevamos el carnet sanitario de tu mascota y te avisamos cuando toca vacuna o desparasitación." }] },

  { key: "kinesiologia", v: 1, wave: 2, status: "active", variant: "citas", industry: "kinesiologia", emoji: "🧑‍⚕️", tagline: "Rehabilitación y sesiones de kinesiología",
    hours: HOURS_STD, funnel: [{ code: "derivado", name: "Derivado", category: "OPEN", order: 0 }, { code: "evaluacion", name: "Evaluación", category: "OPEN", order: 1 }, { code: "en_tratamiento", name: "En tratamiento", category: "WON", order: 2 }, { code: "alta", name: "Alta", category: "WON", order: 3 }, { code: "abandono", name: "Abandonó", category: "LOST", order: 4 }],
    services: [{ code: "evaluacion", name: "Evaluación kinésica", category: "diagnostico", durationMin: 40, price: 30000 }, { code: "sesion", name: "Sesión de kinesiología", category: "tratamiento", durationMin: 45, price: 25000 }, { code: "pack10", name: "Pack 10 sesiones", category: "pack", durationMin: 45, price: 220000 }],
    tags: [{ name: "Derivado", color: "#2563eb" }, { name: "Pack activo", color: "#16a34a" }, { name: "Riesgo abandono", color: "#dc2626" }],
    customFields: [{ key: "pack_restantes", label: "Sesiones restantes del pack" }, { key: "convenio", label: "Convenio / isapre" }],
    kpis: ["sesiones_hoy", "pacientes_riesgo_abandono", "packs_por_cerrar", "caja_hoy"],
    flows: ["confirmación DIARIA de la sesión de mañana", "anti-abandono: si falta a 1, reagenda; si falta a 2, alerta al dueño", "pack de sesiones con abono por link", "recordatorio de ejercicios post-sesión"],
    hsm: ["recordatorio de sesión", "no te pierdas tu avance, reagendemos"],
    greeting: "¡Hola! 🧑‍⚕️ ¿Vienes con orden médica o derivación? Cuéntame tu caso y agendamos tu evaluación.",
    prompt: "Atiendes un centro de kinesiología. " + TONE + " Maneja packs de sesiones con contador; refuerza la adherencia (confirmación y reagendo rápido). No das indicaciones clínicas por chat; la orden médica se adjunta a la ficha.",
    faq: [{ title: "Packs de sesiones", content: "El tratamiento suele ser de varias sesiones; puedes tomar un pack con abono y llevamos el conteo en tu ficha." }] },

  { key: "gimnasio", v: 1, wave: 2, status: "active", variant: "citas", req: ["groupClasses"], industry: "gimnasio", emoji: "🏋️", tagline: "Clases grupales y membresías",
    hours: { mon: ["07:00-22:00"], tue: ["07:00-22:00"], wed: ["07:00-22:00"], thu: ["07:00-22:00"], fri: ["07:00-22:00"], sat: ["09:00-14:00"], sun: [] },
    funnel: [{ code: "lead", name: "Lead", category: "OPEN", order: 0 }, { code: "prueba", name: "Clase de prueba", category: "OPEN", order: 1 }, { code: "matriculado", name: "Matriculado", category: "WON", order: 2 }, { code: "activo", name: "Activo", category: "WON", order: 3 }, { code: "riesgo", name: "En riesgo", category: "OPEN", order: 4 }, { code: "inactivo", name: "Inactivo", category: "LOST", order: 5 }],
    services: [{ code: "clase-prueba", name: "Clase de prueba", category: "clase", durationMin: 60, price: 0 }, { code: "membresia-mensual", name: "Membresía mensual", category: "membresia", durationMin: 0, price: 35000 }],
    tags: [{ name: "Lead", color: "#2563eb" }, { name: "Activo", color: "#16a34a" }, { name: "En riesgo", color: "#dc2626" }],
    kpis: ["clases_hoy_ocupacion", "membresias_por_vencer", "en_riesgo", "caja_hoy"],
    flows: ["clase de prueba desde Ads con confirmación", "cobro mensual de membresía con reintento", "te extrañamos al caer la asistencia", "lista de espera de cupos"],
    hsm: ["recordatorio de clase", "tu membresía vence pronto"],
    greeting: "¡Hola! 🏋️ ¿Quieres venir a una clase de prueba? Cuéntame qué disciplina te interesa.",
    prompt: "Atiendes un gimnasio boutique. " + TONE + " Ofreces clase de prueba, matrícula y membresías mensuales. (Las clases grupales con cupos se habilitan cuando la agenda lo soporte.)",
    faq: [{ title: "Clases y membresías", content: "Puedes agendar una clase de prueba; las membresías son mensuales con renovación." }] },

  { key: "taller", v: 1, wave: 2, status: "active", variant: "citas", industry: "taller", emoji: "🔧", tagline: "Taller mecánico y servitecas",
    hours: { mon: ["08:30-18:30"], tue: ["08:30-18:30"], wed: ["08:30-18:30"], thu: ["08:30-18:30"], fri: ["08:30-18:30"], sat: ["09:00-13:00"], sun: [] },
    funnel: [{ code: "cotizacion", name: "Cotización", category: "OPEN", order: 0 }, { code: "agendado", name: "Agendado", category: "OPEN", order: 1 }, { code: "en_taller", name: "En taller", category: "OPEN", order: 2 }, { code: "listo", name: "Listo para retiro", category: "WON", order: 3 }, { code: "entregado", name: "Entregado", category: "WON", order: 4 }, { code: "perdido", name: "No concretó", category: "LOST", order: 5 }],
    services: [{ code: "mantencion", name: "Mantención básica", category: "mantencion", durationMin: 120, price: 60000 }, { code: "diagnostico", name: "Diagnóstico / escaneo", category: "diagnostico", durationMin: 60, price: 20000 }, { code: "frenos", name: "Revisión de frenos", category: "reparacion", durationMin: 90, price: 45000 }],
    tags: [{ name: "Cotización", color: "#2563eb" }, { name: "En taller", color: "#d97706" }, { name: "Mantención programada", color: "#16a34a" }],
    customEntities: { vehiculos: { label: "Vehículos", fields: ["patente", "marca", "modelo", "anio", "proximo_mantenimiento_km"], repeatable: true } },
    kpis: ["autos_en_taller_por_estado", "retiros_hoy", "cotizaciones_sin_responder", "caja_hoy"],
    flows: ["estado de la orden (diagnóstico / listo para retiro) con 1 toque", "pre-cotización por foto/patente (humano aprueba)", "recordatorio de mantención por km/fecha", "seña para repuestos caros"],
    hsm: ["tu vehículo está listo", "recordatorio de mantención de los 10.000 km"],
    greeting: "¡Hola! 🔧 Para ayudarte, ¿me das la patente de tu vehículo y qué necesitas (mantención, diagnóstico o una falla)?",
    prompt: "Atiendes un taller mecánico. Pide SIEMPRE la PATENTE primero: es la llave de la ficha del vehículo (un cliente puede tener varios). " + TONE + " Las cotizaciones por foto las aprueba una persona del taller.",
    faq: [{ title: "Estado de mi auto", content: "Con tu patente te decimos en qué etapa está tu vehículo y cuándo estará listo para retiro." }] },

  { key: "servicios_domicilio", v: 1, wave: 2, status: "active", variant: "citas", industry: "servicios_domicilio", emoji: "🛠️", tagline: "Clima, instalaciones y eléctricos con cuadrillas",
    hours: { mon: ["09:00-18:00"], tue: ["09:00-18:00"], wed: ["09:00-18:00"], thu: ["09:00-18:00"], fri: ["09:00-18:00"], sat: ["09:00-13:00"], sun: [] },
    funnel: [{ code: "lead", name: "Lead", category: "OPEN", order: 0 }, { code: "visita", name: "Visita agendada", category: "OPEN", order: 1 }, { code: "cotizado", name: "Cotizado", category: "OPEN", order: 2 }, { code: "aprobado", name: "Aprobado", category: "WON", order: 3 }, { code: "ejecutado", name: "Ejecutado", category: "WON", order: 4 }, { code: "perdido", name: "No concretó", category: "LOST", order: 5 }],
    services: [{ code: "visita-diagnostico", name: "Visita de diagnóstico", category: "visita", durationMin: 60, price: 20000 }, { code: "instalacion", name: "Instalación", category: "trabajo", durationMin: 120, price: 0 }],
    tags: [{ name: "Lead", color: "#2563eb" }, { name: "Cotizado", color: "#d97706" }, { name: "Garantía", color: "#16a34a" }],
    customFields: [{ key: "comuna", label: "Comuna" }, { key: "direccion", label: "Dirección" }],
    kpis: ["visitas_hoy_por_tecnico", "cotizaciones_por_aprobar", "caja_hoy"],
    flows: ["calificación del lead (comuna→cobertura, tipo de trabajo, urgencia)", "pre-cotización por foto (humano aprueba)", "anticipo por link", "el técnico va en camino", "post-servicio con garantía y reseña"],
    hsm: ["tu técnico va en camino", "cotización lista"],
    greeting: "¡Hola! 🛠️ Para ayudarte, ¿en qué comuna estás y qué trabajo necesitas?",
    prompt: "Atiendes una empresa de servicios a domicilio. VALIDA primero la comuna/cobertura antes de agendar; pide dirección y tipo de trabajo. " + TONE + " Las cotizaciones por foto las aprueba una persona.",
    faq: [{ title: "Cobertura", content: "Primero confirmamos si llegamos a tu comuna; luego agendamos una visita o cotizamos según el trabajo." }] },

  { key: "psicologia", v: 1, wave: 2, status: "active", variant: "citas", industry: "psicologia", emoji: "🧠", tagline: "Centros de psicología y salud mental",
    hours: HOURS_STD, funnel: FUNNEL("Nuevo"),
    services: [{ code: "primera-sesion", name: "Primera sesión", category: "sesion", durationMin: 50, price: 35000 }, { code: "sesion", name: "Sesión de terapia", category: "sesion", durationMin: 50, price: 35000 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }, { name: "En tratamiento", color: "#16a34a" }, { name: "Pausado", color: "#d97706" }],
    customFields: [{ key: "modalidad", label: "Presencial / online" }],
    kpis: ["sesiones_hoy", "pagadas_vs_pendientes", "pacientes_pausados"],
    flows: ["sesión semanal recurrente (mismo día/hora)", "cobro anticipado al agendar", "confirmación 24h con reagendo", "alerta de pausa de tratamiento"],
    hsm: ["recordatorio de sesión", "tu horario semanal te espera"],
    greeting: "Hola, gracias por escribir. Estoy para ayudarte con la coordinación de tu hora. ¿Buscas una primera sesión o ya estás en tratamiento?",
    prompt: "Eres la recepción de un centro de psicología. Tono SOBRIO, respetuoso y confidencial. Tu rol es SOLO logístico: agendar, confirmar y coordinar pagos. CERO contenido clínico por chat; no interpretes ni aconsejes. Si la persona expresa riesgo para sí misma o terceros, con calidez indícale que contacte de inmediato a la línea de prevención del suicidio *4141 (Salud Responde 600 360 7777) o acuda a urgencias, y deriva a una persona del equipo (transferToHuman). El cobro suele ser anticipado al agendar. Las sesiones online llevan link de videollamada en la cita.",
    faq: [{ title: "Cómo agendar", content: "Coordinamos tu hora (presencial u online). El pago suele ser anticipado para confirmar la reserva." }] },

  // ===== OLA 3 (v1, beta — solo el equipo instala desde la consola) =====
  { key: "implante_capilar", v: 1, wave: 3, status: "beta", variant: "citas", industry: "implante_capilar", emoji: "💇", tagline: "Implante capilar / cirugía estética",
    services: [{ code: "evaluacion", name: "Evaluación (presencial o por foto)", category: "diagnostico", durationMin: 30, price: 0 }],
    tags: [{ name: "Lead Ads", color: "#2563eb" }], customFields: [{ key: "financiamiento", label: "Financiamiento" }],
    kpis: ["leads_respondidos_rapido", "evaluaciones_agendadas"],
    greeting: "¡Hola! Gracias por tu interés. Para orientarte, ¿me cuentas qué buscas y envías una foto de la zona?",
    prompt: "Eres un asesor (SDR) de una clínica de implante capilar. Respondes RÁPIDO, calificas el caso y agendas una evaluación (presencial o por foto). " + TONE + " El financiamiento se registra en la ficha; el presupuesto final lo da el profesional.",
    faq: [{ title: "Cómo partir", content: "Agendamos una evaluación para ver tu caso y darte un presupuesto; puede ser presencial o con fotos." }] },

  { key: "escuela_conducir", v: 1, wave: 3, status: "beta", variant: "citas", industry: "escuela_conducir", emoji: "🚗", tagline: "Escuelas de conducir",
    services: [{ code: "clase-practica", name: "Clase práctica", category: "clase", durationMin: 60, price: 20000 }, { code: "matricula", name: "Matrícula / paquete", category: "paquete", durationMin: 0, price: 200000 }],
    tags: [{ name: "Interesado", color: "#2563eb" }], kpis: ["clases_hoy", "matriculas_mes"],
    greeting: "¡Hola! 🚗 ¿Te interesa matricularte o agendar clases prácticas? Te cuento los paquetes.",
    prompt: "Atiendes una escuela de conducir. " + TONE + " Ofreces matrícula con link de pago y agendas clases prácticas; llevas el conteo de clases del paquete.",
    faq: [{ title: "Paquetes", content: "Tenemos paquetes de clases prácticas y matrícula; te agendamos según disponibilidad del instructor." }] },

  { key: "corretaje", v: 1, wave: 3, status: "beta", variant: "leads", industry: "corretaje", emoji: "🏠", tagline: "Corretaje inmobiliario (calificador de leads)",
    services: [{ code: "visita", name: "Visita a propiedad", category: "visita", durationMin: 45, price: 0 }],
    tags: [{ name: "Interesado", color: "#2563eb" }, { name: "Calificado", color: "#16a34a" }],
    customFields: [{ key: "presupuesto", label: "Presupuesto" }, { key: "comuna", label: "Comuna" }, { key: "preaprobacion", label: "Pre-aprobación" }],
    kpis: ["leads_nuevos", "visitas_agendadas"],
    greeting: "¡Hola! 🏠 Para ayudarte a encontrar propiedad, ¿en qué comuna buscas y cuál es tu presupuesto?",
    prompt: "Eres un asesor inmobiliario. CALIFICA el lead (presupuesto, comuna, pre-aprobación) y agenda visitas. " + TONE + " Sin recurrencia: foco en calificar y coordinar visitas.",
    faq: [{ title: "Cómo ayudamos", content: "Te ayudamos a encontrar y visitar propiedades según tu presupuesto y comuna." }] },

  { key: "alojamiento", v: 1, wave: 3, status: "beta", variant: "estadias", industry: "alojamiento", emoji: "🏡", tagline: "Cabañas / alojamiento boutique",
    services: [{ code: "noche", name: "Noche de estadía", category: "estadia", durationMin: 0, price: 60000 }],
    tags: [{ name: "Consulta", color: "#2563eb" }, { name: "Reservado", color: "#16a34a" }],
    customFields: [{ key: "personas", label: "N° de personas" }],
    kpis: ["reservas_proximas", "ocupacion"],
    greeting: "¡Hola! 🏡 ¿Para qué fechas y cuántas personas buscas alojamiento? Te cuento disponibilidad.",
    prompt: "Atiendes un alojamiento boutique. Consultas fechas y número de personas, informas disponibilidad y tomas reservas con seña por link (30-50%). " + TONE + " No tenemos integración con portales (channel manager): confirma siempre la disponibilidad.",
    faq: [{ title: "Reservas", content: "Dinos fechas y personas; confirmamos disponibilidad y reservamos con una seña." }] },

  { key: "spa", v: 1, wave: 3, status: "beta", variant: "citas", industry: "spa", emoji: "💆", tagline: "Spa y masajes",
    services: [{ code: "masaje", name: "Masaje relajante", category: "masaje", durationMin: 60, price: 30000 }, { code: "giftcard", name: "Gift card", category: "giftcard", durationMin: 0, price: 30000 }],
    tags: [{ name: "Primera vez", color: "#2563eb" }], kpis: ["sesiones_hoy", "caja_hoy"],
    greeting: "¡Hola! 💆 ¿Buscas agendar un masaje o un momento de relajo? Cuéntame qué te gustaría.",
    prompt: "Atiendes un spa. " + TONE + " Ofreces sesiones y gift cards.",
    faq: [{ title: "Reservas", content: "Agenda tu sesión por WhatsApp; también tenemos gift cards para regalar." }] },

  { key: "tatuajes", v: 1, wave: 3, status: "beta", variant: "citas", industry: "tatuajes", emoji: "🎨", tagline: "Estudios de tatuajes / piercing",
    services: [{ code: "sesion", name: "Sesión de tatuaje", category: "tatuaje", durationMin: 180, price: 0 }],
    tags: [{ name: "Brief enviado", color: "#2563eb" }], customFields: [{ key: "zona", label: "Zona y tamaño" }],
    kpis: ["sesiones_hoy", "senas_pendientes"],
    greeting: "¡Hola! 🎨 Cuéntame tu idea (zona, tamaño, referencia) y coordinamos una hora. Las reservas llevan seña.",
    prompt: "Atiendes un estudio de tatuajes. Pides brief con fotos de referencia, zona y tamaño; la hora se bloquea y requiere SEÑA por link para reservar. " + TONE + " Entregas cuidados post-tatuaje.",
    faq: [{ title: "Reservas", content: "Las sesiones se reservan con seña porque bloquean varias horas; coordinamos según el diseño." }] },

  { key: "restaurante_reservas", v: 1, wave: 3, status: "beta", variant: "mesas", industry: "restaurante_reservas", emoji: "🍽️", tagline: "Restaurantes con reserva (no delivery)",
    services: [{ code: "reserva", name: "Reserva de mesa", category: "reserva", durationMin: 120, price: 0 }],
    tags: [{ name: "Reserva", color: "#2563eb" }, { name: "Grupo", color: "#d97706" }],
    customFields: [{ key: "personas", label: "N° de comensales" }],
    kpis: ["reservas_hoy", "no_show"],
    greeting: "¡Hola! 🍽️ ¿Para cuántas personas y qué día/hora te gustaría reservar?",
    prompt: "Atiendes las reservas de un restaurante (no pedidos ni delivery). " + TONE + " Confirmas la reserva el mismo día; para grupos de 6+ pides seña anti no-show. Eventos/banquetería se cotizan aparte.",
    faq: [{ title: "Reservas", content: "Tomamos reservas de mesa; para grupos grandes pedimos una seña para asegurar el cupo." }] },

  { key: "abogados", v: 1, wave: 3, status: "beta", variant: "intake", industry: "abogados", emoji: "⚖️", tagline: "Estudios jurídicos (intake de casos)",
    services: [{ code: "primera-consulta", name: "Primera consulta (pagada)", category: "consulta", durationMin: 45, price: 40000 }],
    tags: [{ name: "Consulta", color: "#2563eb" }, { name: "Calificado", color: "#16a34a" }],
    customFields: [{ key: "materia", label: "Materia" }, { key: "urgencia", label: "Urgencia" }],
    kpis: ["consultas_agendadas", "casos_calificados"],
    greeting: "Hola, gracias por escribir. Para orientarle, ¿cuál es la materia de su consulta y su urgencia?",
    prompt: "Eres la recepción de un estudio jurídico. Tono FORMAL y confidencial. Calificas el caso (materia, urgencia, comuna) y agendas una primera consulta PAGADA por link (filtra curiosos). " + TONE + " No das asesoría legal por chat.",
    faq: [{ title: "Primera consulta", content: "La primera consulta es pagada y permite evaluar su caso con un abogado." }] },

  { key: "optica", v: 1, wave: 3, status: "beta", variant: "citas", industry: "optica", emoji: "👓", tagline: "Ópticas",
    services: [{ code: "examen", name: "Examen de vista", category: "examen", durationMin: 30, price: 0 }],
    tags: [{ name: "Examen", color: "#2563eb" }, { name: "Pedido listo", color: "#16a34a" }],
    kpis: ["examenes_hoy", "pedidos_listos"],
    greeting: "¡Hola! 👓 ¿Buscas un examen de vista o consultar por tus lentes? Te ayudo.",
    prompt: "Atiendes una óptica. " + TONE + " Agendas exámenes de vista y avisas cuando los lentes están listos; recuerdas el control anual.",
    faq: [{ title: "Tus lentes", content: "Te avisamos cuando tus lentes estén listos para retiro y te recordamos tu control anual." }] },

  { key: "control_plagas", v: 1, wave: 3, status: "beta", variant: "citas", industry: "control_plagas", emoji: "🐜", tagline: "Control de plagas / sanitización",
    services: [{ code: "visita", name: "Visita de control", category: "visita", durationMin: 60, price: 30000 }],
    tags: [{ name: "Nuevo", color: "#2563eb" }, { name: "Contrato", color: "#16a34a" }],
    customFields: [{ key: "comuna", label: "Comuna" }],
    kpis: ["visitas_hoy", "servicios_por_renovar"],
    greeting: "¡Hola! 🐜 Para ayudarte, ¿en qué comuna estás y qué tipo de plaga o servicio necesitas?",
    prompt: "Atiendes una empresa de control de plagas. Validas comuna/cobertura y agendas la visita; el servicio suele ser recurrente (trimestral/semestral) con certificado post-servicio. " + TONE,
    faq: [{ title: "Servicio recurrente", content: "Ofrecemos servicios puntuales y planes recurrentes con certificado después de cada visita." }] },

  { key: "lavanderia", v: 1, wave: 3, status: "beta", variant: "pedidos", industry: "lavanderia", emoji: "🧺", tagline: "Lavandería con retiro/entrega",
    services: [{ code: "retiro", name: "Retiro y entrega", category: "pedido", durationMin: 0, price: 0 }],
    tags: [{ name: "Pedido", color: "#2563eb" }, { name: "Suscripción", color: "#16a34a" }],
    customFields: [{ key: "direccion", label: "Dirección de retiro" }],
    kpis: ["retiros_hoy", "pedidos_listos"],
    greeting: "¡Hola! 🧺 ¿Quieres coordinar un retiro de tu ropa? Dime tu dirección y para cuándo.",
    prompt: "Atiendes una lavandería con retiro/entrega. Coordinas el retiro agendado, avisas cuando está listo y coordinas la entrega. " + TONE + " Ofreces suscripción semanal si aplica.",
    faq: [{ title: "Retiro y entrega", content: "Coordinamos el retiro de tu ropa, te avisamos cuando está lista y la entregamos." }] },
];

// Nota de MODO DUEÑO (F8): solo aplica cuando quien escribe es el dueño (ownerContext);
// el cliente final nunca ve estas tools. Confirmación en dos pasos para cambios que afectan citas.
const OWNER_NOTE =
  "\n\nMODO DUEÑO (solo si quien escribe es el dueño/administrador del negocio): puedes administrar la agenda con tus herramientas (horarios de cada persona, ausencias/vacaciones, alta/baja de quien atiende, horario del local, duración/precio de servicios). ANTES de un cambio que afecte citas ya tomadas, RESUME el impacto (cuántas citas y de quién) y pide confirmación explícita; recién entonces ejecútalo y ofrece reagendar o avisar a los afectados. Nunca ejecutes cambios destructivos sin el OK. Si quien escribe es un cliente, ignora todo esto: tú no tienes estas funciones para él.";
// Tools de administración de agenda (ownerOnly): se exponen SOLO en modo dueño.
const OWNER_TOOLS = ["upsertProfessional", "updateProfessionalSchedule", "addProfessionalTimeOff", "updateBusinessHours", "updateServiceConfig"];

function agentFor(r) {
  const slug = "recepcion";
  // El agente de recepción incluye las tools de dueño (gated por ownerContext): el cliente
  // final no las ve; el dueño sí. (Las tools de atención al cliente se afinan en el
  // refinamiento de contenido por rubro.)
  return [{ slug, name: "Recepción", description: "Atiende, agenda y responde dudas.", kind: "recepcion", systemPrompt: r.prompt + OWNER_NOTE, config: {}, tools: [...OWNER_TOOLS] }];
}

function buildDefinition(r) {
  const def = {
    industry: r.industry,
    ui: { emoji: r.emoji, tagline: r.tagline },
    modules: { agenda: r.variant !== "pedidos" },
    businessHours: r.hours ?? HOURS_STD,
    leadStatuses: r.funnel ?? FUNNEL(),
    services: r.services ?? [],
    tags: r.tags ?? [],
    agents: agentFor(r),
    workflows: [bienvenida(r.greeting)],
    knowledge: r.faq ? [{ baseName: "FAQ " + r.key, documents: r.faq }] : [],
    kpis: r.kpis ?? [],
  };
  if (r.customFields) def.customFields = r.customFields;
  if (r.customEntities) def.customEntities = r.customEntities;
  if (r.flows) def.flows = r.flows;
  if (r.hsm) def.hsm = r.hsm;
  return def;
}

const out = R.map((r) => ({
  key: r.key,
  version: r.v,
  wave: r.wave,
  status: r.status,
  variant: r.variant,
  requiresFeature: r.req ?? [],
  name: labelFromKey(r.key),
  definition: buildDefinition(r),
}));

function labelFromKey(key) {
  const names = { generico: "General / otro rubro", dental: "Clínica dental", centro_medico: "Centro médico", estetica: "Centro de estética", barberia: "Barbería", peluqueria: "Peluquería", medspa: "Medicina estética / medspa", veterinaria: "Veterinaria", kinesiologia: "Kinesiología", gimnasio: "Gimnasio boutique", taller: "Taller mecánico", servicios_domicilio: "Servicios a domicilio", psicologia: "Psicología", implante_capilar: "Implante capilar", escuela_conducir: "Escuela de conducir", corretaje: "Corretaje inmobiliario", alojamiento: "Alojamiento boutique", spa: "Spa / masajes", tatuajes: "Tatuajes / piercing", restaurante_reservas: "Restaurante con reserva", abogados: "Estudio jurídico", optica: "Óptica", control_plagas: "Control de plagas", lavanderia: "Lavandería" };
  return names[key] ?? key;
}

writeFileSync(join(here, "..", "seeds", "vertical-templates.json"), JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`✔ vertical-templates.json generado: ${out.length} rubros (${out.filter((t) => t.status === "active").length} active, ${out.filter((t) => t.status === "beta").length} beta).`);
