import type { Escenario } from "./arnes";

/**
 * LOS ESCENARIOS. Cada uno es un caso que pasó o que va a pasar.
 *
 * Los dos primeros son los ESCENARIOS REALES del documento: la captura del 11-nov y lo que
 * tiene que ocurrir al día siguiente desde otro equipo.
 */

const AHORA = new Date("2026-11-12T12:00:00Z");
const haceHoras = (h: number) => new Date(AHORA.getTime() - h * 3_600_000);

const PLAN_BASE = { code: "conversia_creditos_base", name: "Base", brand: "conversia", priceClp: 24990, active: true };
const PLAN_PRUEBA = { code: "conversia_creditos_trial", name: "Prueba", brand: "conversia", priceClp: 0, active: true };

const convSana = {
  cuentaVigente: true,
  creditos: 500,
  iaActiva: true,
  intervencionHumana: false,
  tieneAsistente: true,
  ultimoEntranteEn: haceHoras(1),
  ultimoSalienteEn: haceHoras(0.5),
  errorDelProveedor: null,
  ahora: AHORA,
};

export const ESCENARIOS: Escenario[] = [
  // ───────────────────────── ESCENARIO REAL 1 (captura del 11-nov) ─────────────────────────
  {
    nombre: "REAL 1 — prueba vencida: «el asistente no responde»",
    mensaje: "el asistente no responde",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-11-03T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_PRUEBA,
      suscripcion: null,
    },
    conversacion: { ...convSana, cuentaVigente: false, ultimoSalienteEn: null },
    // Lo que hacía antes: escalar. Ahora eso NO corresponde.
    intentaEscalarCon: { motivo: "la vigencia del servicio venció", consultado: ["estadoDeCuenta → vencida"] },
    espera: {
      puedeCrear: false,
      loResuelveElEquipo: false,
      causa: "cuenta_vencida",
      herramienta: "generarEnlaceDePago",
      escala: false,
    },
  },
  {
    nombre: "REAL 1b — «ok» tras ofrecer el pago: NO intenta probar una cuenta vencida",
    mensaje: "ok",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-11-03T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_PRUEBA,
      suscripcion: null,
    },
    espera: { puedeCrear: false, loResuelveElEquipo: false },
  },
  {
    nombre: "REAL 1c — «ahora puedes?» después de pagar: la prueba CORRE",
    mensaje: "ahora puedes?",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      // Pagó: la suscripción viva manda sobre el validUntil viejo (#639). Este es el caso que
      // producía el «no puedo probar el asistente».
      vigencia: { vigente: true, motivo: "cubierto_por_suscripcion", validUntil: "2026-11-03T00:00:00.000Z", cubiertoHasta: "2026-12-11T00:00:00.000Z" },
      plan: PLAN_BASE,
      suscripcion: { status: "ACTIVE", periodEnd: "2026-12-11T00:00:00.000Z" },
    },
    conversacion: { ...convSana },
    espera: { puedeCrear: true, causa: "respondio", herramienta: null },
  },

  // ───────────────────────── ESCENARIO REAL 2 (al día siguiente) ─────────────────────────
  {
    nombre: "REAL 2 — vuelve al día siguiente desde otro equipo, ya pagado",
    mensaje: "hola",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: true, motivo: "al_dia", validUntil: "2026-12-11T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_BASE,
      suscripcion: { status: "ACTIVE", periodEnd: "2026-12-11T00:00:00.000Z" },
    },
    espera: { puedeCrear: true, loResuelveElEquipo: false },
  },

  // ───────────────────────── Los demás del documento ─────────────────────────
  {
    nombre: "saldo en cero → recarga, no escalamiento",
    mensaje: "el bot dejó de contestar de golpe",
    conversacion: { ...convSana, creditos: 0, ultimoSalienteEn: null },
    intentaEscalarCon: { motivo: "se quedó sin créditos", consultado: ["estadoDeCreditos → 0"] },
    espera: { causa: "sin_creditos", herramienta: "generarEnlaceDePago", escala: false },
  },
  {
    nombre: "canal sin asistente → lo asigna",
    mensaje: "le escribieron y nadie contestó",
    conversacion: { ...convSana, tieneAsistente: false, ultimoSalienteEn: null },
    espera: { causa: "sin_asistente", herramienta: "asignarAsistenteACanal" },
  },
  {
    nombre: "bot pausado → lo reanuda",
    mensaje: "por qué no está respondiendo",
    conversacion: { ...convSana, iaActiva: false, ultimoSalienteEn: null },
    espera: { causa: "bot_pausado", herramienta: "retomarBotEnConversacion" },
  },
  {
    nombre: "la tomó una persona del equipo → NO es un problema",
    mensaje: "el bot no contesta a este cliente",
    conversacion: { ...convSana, intervencionHumana: true, iaActiva: false, ultimoSalienteEn: null },
    espera: { causa: "intervencion_humana", herramienta: "retomarBotEnConversacion" },
  },
  {
    nombre: "fuera de la ventana de 24 h → plantilla",
    mensaje: "no le llega nada al cliente",
    conversacion: { ...convSana, ultimoEntranteEn: haceHoras(30), ultimoSalienteEn: null },
    espera: { causa: "fuera_de_ventana", herramienta: "listarPlantillasWhatsapp" },
  },
  {
    nombre: "Meta rechazó el envío → prueba el canal",
    mensaje: "dice que no se envió",
    conversacion: { ...convSana, errorDelProveedor: "131049: no se puede enviar", ultimoSalienteEn: null },
    espera: { causa: "error_del_proveedor", herramienta: "probarCanal" },
  },

  // ───────────────────────── Escalamiento: lo que SÍ y lo que NO ─────────────────────────
  {
    nombre: "verificación de Meta pendiente → SÍ escala",
    mensaje: "me piden verificar el negocio y no sé qué hacer",
    intentaEscalarCon: { motivo: "verificacion_meta", consultado: ["estadoWhatsapp → verificación pendiente"] },
    espera: { escala: true },
  },
  {
    nombre: "pide hablar con una persona → SÍ escala, sin diagnosticar",
    mensaje: "quiero hablar con alguien del equipo",
    intentaEscalarCon: { motivo: "pidio_una_persona", consultado: [] },
    espera: { escala: true },
  },
  {
    nombre: "restricción de WhatsApp → SÍ escala",
    mensaje: "me llegó un aviso de Meta de que mi cuenta está restringida",
    intentaEscalarCon: { motivo: "restriccion_whatsapp", consultado: ["estadoWhatsapp → restringida"] },
    espera: { escala: true },
  },
  {
    nombre: "inconsistencia nuestra (pago sin suscripción) → SÍ escala y NO le cobra de nuevo",
    mensaje: "pagué ayer y sigue diciendo que está vencida",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: false, motivo: "vencida", validUntil: "2026-11-03T00:00:00.000Z", cubiertoHasta: null },
      plan: PLAN_BASE,
      suscripcion: null,
      pagoRegistradoSinSuscripcion: true,
    },
    intentaEscalarCon: { motivo: "inconsistencia_interna", consultado: ["estadoDeCuenta → pago sin suscripción"] },
    espera: { puedeCrear: false, loResuelveElEquipo: true, escala: true },
  },
  {
    nombre: "«no pude resolverlo» → NO escala: eso es rendirse",
    mensaje: "ayúdame con esto",
    intentaEscalarCon: { motivo: "no pude resolverlo", consultado: ["estadoDeCuenta → al día"] },
    espera: { escala: false },
  },
  {
    nombre: "escalar sin haber mirado nada → NO escala",
    mensaje: "algo no anda",
    intentaEscalarCon: { motivo: "restriccion_whatsapp", consultado: [] },
    espera: { escala: false },
  },

  // ───────────────────────── Cuenta sana ─────────────────────────
  {
    nombre: "cuenta sana → no inventa bloqueos",
    mensaje: "cómo voy",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: true, motivo: "al_dia", validUntil: null, cubiertoHasta: null },
      plan: PLAN_BASE,
      suscripcion: { status: "ACTIVE", periodEnd: "2027-01-01T00:00:00.000Z" },
    },
    espera: { puedeCrear: true, loResuelveElEquipo: false },
  },
  {
    nombre: "plan de OTRA marca → avisa pero NO bloquea",
    mensaje: "está todo bien?",
    cuenta: {
      orgStatus: "ACTIVE",
      orgBrand: "conversia",
      vigencia: { vigente: true, motivo: "al_dia", validUntil: null, cubiertoHasta: null },
      plan: { code: "starter", name: "Starter", brand: "tubot", priceClp: 69900, active: true },
      suscripcion: { status: "ACTIVE", periodEnd: "2027-01-01T00:00:00.000Z" },
    },
    espera: { puedeCrear: true },
  },
];
