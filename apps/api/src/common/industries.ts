/**
 * Rubros (industrias) y su capa de personalización: VOCABULARIO (etiquetas de la
 * UI) y MÓDULOS visibles. NO renombra el modelo de datos: es una capa de
 * traducción sobre las etiquetas, resuelta en `base ← rubro ← override del tenant`.
 * El tenant puede editar los términos y los módulos en Configuración.
 */

/** Términos canónicos traducibles (claves internas; el valor es la etiqueta visible). */
export type TermKey =
  | "contact" | "contacts"
  | "service" | "services"
  | "professional" | "professionals"
  | "appointment" | "appointments"
  | "branch";

export type Vocabulary = Record<TermKey, string>;

/** Módulos que se pueden ocultar por rubro (no rompen rutas ni datos, solo el menú). */
export type ModuleKey = "agenda";
export type Modules = Record<ModuleKey, boolean>;

export const BASE_VOCAB: Vocabulary = {
  contact: "Contacto", contacts: "Contactos",
  service: "Servicio", services: "Servicios",
  professional: "Miembro del equipo", professionals: "Equipo",
  appointment: "Cita", appointments: "Citas",
  branch: "Sucursal",
};

export interface Industry {
  code: string;
  label: string;
  vocab: Partial<Vocabulary>;
  /** Módulos ACTIVOS por defecto para el rubro (los ausentes usan el base). */
  modules?: Partial<Modules>;
}

/** Catálogo de rubros con su vocabulario y módulos por defecto. */
export const INDUSTRIES: Industry[] = [
  { code: "generico", label: "General / otro", vocab: {}, modules: { agenda: true } },
  { code: "comercio", label: "Comercio / e-commerce", vocab: { contact: "Cliente", contacts: "Clientes", service: "Producto", services: "Productos", professional: "Vendedor", professionals: "Vendedores", branch: "Tienda" }, modules: { agenda: false } },
  { code: "servicios", label: "Servicios profesionales", vocab: { contact: "Cliente", contacts: "Clientes", professional: "Profesional", professionals: "Profesionales", branch: "Oficina" }, modules: { agenda: true } },
  { code: "salud", label: "Salud", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Tratamiento", services: "Tratamientos", professional: "Profesional", professionals: "Profesionales", branch: "Sede" }, modules: { agenda: true } },
  { code: "dental", label: "Dental / odontología", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Tratamiento", services: "Tratamientos", professional: "Dentista", professionals: "Dentistas", appointment: "Cita", appointments: "Citas", branch: "Sede" }, modules: { agenda: true } },
  { code: "barberia", label: "Barbería / peluquería", vocab: { contact: "Cliente", contacts: "Clientes", service: "Servicio", services: "Servicios", professional: "Barbero", professionals: "Barberos", appointment: "Reserva", appointments: "Reservas", branch: "Local" }, modules: { agenda: true } },
  { code: "peluqueria", label: "Peluquería", vocab: { contact: "Cliente", contacts: "Clientes", service: "Servicio", services: "Servicios", professional: "Estilista", professionals: "Estilistas", appointment: "Reserva", appointments: "Reservas", branch: "Local" }, modules: { agenda: true } },
  { code: "estetica", label: "Centro de estética", vocab: { contact: "Cliente", contacts: "Clientes", service: "Tratamiento", services: "Tratamientos", professional: "Especialista", professionals: "Especialistas", appointment: "Sesión", appointments: "Sesiones", branch: "Centro" }, modules: { agenda: true } },
  { code: "centro_medico", label: "Centro médico", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Prestación", services: "Prestaciones", professional: "Médico", professionals: "Médicos", appointment: "Hora", appointments: "Horas", branch: "Sede" }, modules: { agenda: true } },
  // ---- Catálogo de rubros (docs/CONVERSIA_RUBROS.md) — ola 2 ----
  { code: "medspa", label: "Medicina estética / medspa", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Tratamiento", services: "Tratamientos", professional: "Profesional", professionals: "Profesionales", appointment: "Sesión", appointments: "Sesiones", branch: "Clínica" }, modules: { agenda: true } },
  { code: "veterinaria", label: "Veterinaria", vocab: { contact: "Tutor", contacts: "Tutores", service: "Atención", services: "Atenciones", professional: "Veterinario", professionals: "Veterinarios", appointment: "Hora", appointments: "Horas", branch: "Clínica" }, modules: { agenda: true } },
  { code: "kinesiologia", label: "Kinesiología / rehabilitación", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Sesión", services: "Sesiones", professional: "Kinesiólogo", professionals: "Kinesiólogos", appointment: "Sesión", appointments: "Sesiones", branch: "Centro" }, modules: { agenda: true } },
  { code: "gimnasio", label: "Gimnasio boutique / studio", vocab: { contact: "Alumno", contacts: "Alumnos", service: "Clase", services: "Clases", professional: "Coach", professionals: "Coaches", appointment: "Clase", appointments: "Clases", branch: "Sede" }, modules: { agenda: true } },
  { code: "taller", label: "Taller mecánico / serviteca", vocab: { contact: "Cliente", contacts: "Clientes", service: "Trabajo", services: "Trabajos", professional: "Mecánico", professionals: "Mecánicos", appointment: "Orden", appointments: "Órdenes", branch: "Taller" }, modules: { agenda: true } },
  { code: "servicios_domicilio", label: "Servicios a domicilio", vocab: { contact: "Cliente", contacts: "Clientes", service: "Trabajo", services: "Trabajos", professional: "Técnico", professionals: "Técnicos", appointment: "Visita", appointments: "Visitas", branch: "Zona" }, modules: { agenda: true } },
  { code: "psicologia", label: "Psicología / salud mental", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Sesión", services: "Sesiones", professional: "Terapeuta", professionals: "Terapeutas", appointment: "Sesión", appointments: "Sesiones", branch: "Centro" }, modules: { agenda: true } },
  // ---- Catálogo de rubros — ola 3 (beta) ----
  { code: "implante_capilar", label: "Implante capilar / cirugía estética", vocab: { contact: "Paciente", contacts: "Pacientes", service: "Tratamiento", services: "Tratamientos", professional: "Profesional", professionals: "Profesionales", appointment: "Evaluación", appointments: "Evaluaciones", branch: "Clínica" }, modules: { agenda: true } },
  { code: "escuela_conducir", label: "Escuela de conducir", vocab: { contact: "Alumno", contacts: "Alumnos", service: "Clase", services: "Clases", professional: "Instructor", professionals: "Instructores", appointment: "Clase", appointments: "Clases", branch: "Sede" }, modules: { agenda: true } },
  { code: "corretaje", label: "Corretaje inmobiliario", vocab: { contact: "Interesado", contacts: "Interesados", service: "Propiedad", services: "Propiedades", professional: "Corredor", professionals: "Corredores", appointment: "Visita", appointments: "Visitas", branch: "Oficina" }, modules: { agenda: true } },
  { code: "alojamiento", label: "Alojamiento boutique / cabañas", vocab: { contact: "Huésped", contacts: "Huéspedes", service: "Estadía", services: "Estadías", professional: "Anfitrión", professionals: "Anfitriones", appointment: "Reserva", appointments: "Reservas", branch: "Propiedad" }, modules: { agenda: true } },
  { code: "spa", label: "Spa / masajes", vocab: { contact: "Cliente", contacts: "Clientes", service: "Tratamiento", services: "Tratamientos", professional: "Especialista", professionals: "Especialistas", appointment: "Sesión", appointments: "Sesiones", branch: "Centro" }, modules: { agenda: true } },
  { code: "tatuajes", label: "Tatuajes / piercing", vocab: { contact: "Cliente", contacts: "Clientes", service: "Trabajo", services: "Trabajos", professional: "Tatuador", professionals: "Tatuadores", appointment: "Hora", appointments: "Horas", branch: "Estudio" }, modules: { agenda: true } },
  { code: "restaurante_reservas", label: "Restaurante con reserva", vocab: { contact: "Comensal", contacts: "Comensales", service: "Reserva", services: "Reservas", professional: "Anfitrión", professionals: "Anfitriones", appointment: "Reserva", appointments: "Reservas", branch: "Local" }, modules: { agenda: true } },
  { code: "abogados", label: "Abogados / estudio jurídico", vocab: { contact: "Consultante", contacts: "Consultantes", service: "Consulta", services: "Consultas", professional: "Abogado", professionals: "Abogados", appointment: "Reunión", appointments: "Reuniones", branch: "Estudio" }, modules: { agenda: true } },
  { code: "optica", label: "Óptica", vocab: { contact: "Cliente", contacts: "Clientes", service: "Examen", services: "Exámenes", professional: "Tecnólogo", professionals: "Tecnólogos", appointment: "Hora", appointments: "Horas", branch: "Local" }, modules: { agenda: true } },
  { code: "control_plagas", label: "Control de plagas / sanitización", vocab: { contact: "Cliente", contacts: "Clientes", service: "Servicio", services: "Servicios", professional: "Técnico", professionals: "Técnicos", appointment: "Visita", appointments: "Visitas", branch: "Zona" }, modules: { agenda: true } },
  { code: "lavanderia", label: "Lavandería con retiro/entrega", vocab: { contact: "Cliente", contacts: "Clientes", service: "Pedido", services: "Pedidos", professional: "Repartidor", professionals: "Repartidores", appointment: "Retiro", appointments: "Retiros", branch: "Local" }, modules: { agenda: true } },
  { code: "educacion", label: "Educación", vocab: { contact: "Alumno", contacts: "Alumnos", service: "Curso", services: "Cursos", professional: "Docente", professionals: "Docentes", appointment: "Clase", appointments: "Clases", branch: "Sede" }, modules: { agenda: true } },
  { code: "inmobiliaria", label: "Inmobiliaria", vocab: { contact: "Interesado", contacts: "Interesados", service: "Propiedad", services: "Propiedades", professional: "Agente", professionals: "Agentes", appointment: "Visita", appointments: "Visitas", branch: "Oficina" }, modules: { agenda: true } },
  { code: "fitness", label: "Gimnasios / fitness", vocab: { contact: "Socio", contacts: "Socios", service: "Clase", services: "Clases", professional: "Entrenador", professionals: "Entrenadores", appointment: "Reserva", appointments: "Reservas", branch: "Sede" }, modules: { agenda: true } },
  { code: "automotriz", label: "Automotriz / taller", vocab: { contact: "Cliente", contacts: "Clientes", service: "Servicio", services: "Servicios", professional: "Mecánico", professionals: "Mecánicos", branch: "Taller" }, modules: { agenda: true } },
  { code: "turismo", label: "Turismo / hotelería", vocab: { contact: "Huésped", contacts: "Huéspedes", service: "Plan", services: "Planes", professional: "Guía", professionals: "Guías", appointment: "Reserva", appointments: "Reservas", branch: "Sucursal" }, modules: { agenda: true } },
];

const DEFAULT_MODULES: Modules = { agenda: true };

/**
 * Resuelve la personalización efectiva del tenant desde `org.settings`:
 * vocabulario = base ← rubro ← override del tenant (`settings.vocabulary`);
 * módulos = default ← rubro ← override del tenant (`settings.modules`).
 */
export function resolvePersonalization(settings: Record<string, any> | null | undefined): {
  industry: string;
  vocabulary: Vocabulary;
  modules: Modules;
} {
  const s = settings ?? {};
  const industryCode = String(s.general?.industry ?? "generico") || "generico";
  const ind = INDUSTRIES.find((i) => i.code === industryCode) ?? INDUSTRIES[0];
  const overrideVocab = (s.vocabulary ?? {}) as Partial<Vocabulary>;
  const overrideModules = (s.modules ?? {}) as Partial<Modules>;
  const vocabulary = { ...BASE_VOCAB, ...ind.vocab, ...cleanStrings(overrideVocab) } as Vocabulary;
  const modules = { ...DEFAULT_MODULES, ...ind.modules, ...overrideModules } as Modules;
  return { industry: industryCode, vocabulary, modules };
}

/** Ignora overrides vacíos para no borrar una etiqueta con "" sin querer. */
function cleanStrings(o: Partial<Vocabulary>): Partial<Vocabulary> {
  const out: Partial<Vocabulary> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.trim()) (out as any)[k] = v.trim();
  return out;
}
