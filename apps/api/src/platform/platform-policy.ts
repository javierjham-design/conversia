/**
 * F10 — Autorización por ROL del administrador de plataforma.
 *
 * Dos clases de rol:
 *  - SUPER ADMIN ("owner" | "admin"): llave de todo (comportamiento actual).
 *  - OPERADOR (cualquier otro rol, p.ej. "operador"): el equipo de implementación
 *    opera la FICHA de clientes (agentes, flujos, números, paquetes, agenda, caja,
 *    impersonar CON auditoría) pero NO toca la configuración GLOBAL de la plataforma
 *    (planes/precios, fusibles, pasarelas de pago, límites globales, infra, otros
 *    administradores). Mitiga el riesgo conocido "el super admin es la llave de todo".
 *
 * La política es una DENYLIST centralizada (una sola fuente de verdad, fácil de auditar
 * y testear): el operador puede TODO bajo /platform/* EXCEPTO las rutas globales de abajo.
 * Las acciones por-org (/platform/organizations/:id/...) ya validan marca con assertOrgBrand.
 */

/** Roles con acceso total al panel de plataforma (equivalente al super admin de hoy). */
const FULL_PLATFORM_ROLES = new Set(["owner", "admin"]);

export function isFullPlatformAdmin(role: string | undefined | null): boolean {
  return FULL_PLATFORM_ROLES.has((role ?? "").toLowerCase());
}

/**
 * Prefijos de rutas GLOBALES/destructivas reservadas al super admin — el operador NO
 * puede tocarlas: planes/precios, fusibles, pasarelas, infra y otros administradores.
 * Las acciones POR-ORG (/platform/organizations/:id/...) se filtran aparte, con
 * OPERATOR_DENY_ORG_ACTIONS.
 */
export const OPERATOR_DENY_PREFIXES = [
  "/platform/metrics", // dashboard con MRR/ingresos/costos de la marca (dato financiero global)
  "/platform/quality", // ranking de tenants (dato sensible agregado) — reservado al super admin
  "/platform/plans", // planes y precios
  "/platform/packages", // paquetes de mensajes
  "/platform/coupons", // cupones
  "/platform/cost-settings", // tarifas WhatsApp + tipo de cambio
  "/platform/cost-model", // modelo de costos / precios IA
  "/platform/templates-pricing", // precio de activación de plantillas
  "/platform/messaging-limits", // topes globales de mensajería (el per-org cap va bajo /organizations)
  "/platform/wallet-weights", // pesos de categoría de la bolsa
  "/platform/billing", // pasarelas (providers/settings/flow) + MRR global (recurring)
  "/platform/invoices", // listado/pago global de facturas (crear factura per-org va bajo /organizations)
  "/platform/margins", // P&L por tenant (dato sensible de negocio)
  "/platform/infra", // monitoreo de infraestructura
  "/platform/test-ai", // probar llaves/modelos globales
  "/platform/audit", // bitácora de cumplimiento (solo super admin)
  "/platform/admins", // gestionar otros administradores/operadores (defensivo, exista o no hoy)
];

/**
 * §3.6 — Acciones POR-ORG reservadas al super admin, bajo `/platform/organizations/:id/`.
 *
 * Son las que, en la ficha de UN cliente, equivalen a tomar posesión de la cuenta o a
 * mover dinero: entrar como el cliente, cambiarle el correo de acceso o la contraseña
 * (ambas = apropiarse de la cuenta), regalar saldo, cambiarle el plan, generar cobros,
 * emitir facturas, suspender/reactivar la cuenta y subirle el tope de mensajería.
 *
 * OJO — ESTO CAMBIA EL ALCANCE DEL ROL OPERADOR respecto de cómo se diseñó F10, que las
 * daba por permitidas ("opera la ficha del cliente, incluido impersonar CON auditoría").
 * La auditoría las considera privilegio de super admin. Queda en una lista aparte, a
 * propósito: devolver alguna al operador es borrar su línea de acá, sin tocar nada más.
 * `impersonate` es la más discutible —es la herramienta diaria del equipo de
 * implementación—; está en el PR para que el dueño decida.
 */
export const OPERATOR_DENY_ORG_ACTIONS = [
  "impersonate", // entrar como el cliente
  "admin/email", // cambiar el correo de acceso = apropiarse de la cuenta
  "admin/reset-password", // idem
  "wallet-adjust", // regalar/quitar saldo
  "subscription", // cambiar el plan contratado
  "billing-action", // cobrar / reintentar / cancelar
  "payment-link", // generar un link de pago
  "invoices", // emitir o pagar facturas de ese cliente
  "status", // suspender o reactivar la cuenta
  "messaging-cap", // subir el tope de mensajería
];

/** `/platform/organizations/<id>/<resto>` → devuelve `<resto>`; null si no calza. */
function orgActionOf(path: string): string | null {
  const m = /^\/platform\/organizations\/[^/]+\/(.+)$/.exec(path);
  return m ? m[1] : null;
}

/**
 * ¿Puede un OPERADOR acceder a esta ruta? true = permitido. Auth (login/MFA) siempre.
 * Coincidencia exacta o por segmento ("/platform/billing/..."), nunca por substring suelto,
 * para no bloquear rutas per-org que comparten raíz con una global.
 *
 * §3.6 — la comparación va en MINÚSCULAS porque Express rutea sin distinguir mayúsculas:
 * `/platform/Billing` llegaba al mismo handler y no calzaba con la denylist, así que el
 * operador entraba a la configuración global cambiando una letra.
 */
export function operatorMayAccess(rawPath: string): boolean {
  const p = ((rawPath || "").split("?")[0].replace(/\/+$/, "") || "/").toLowerCase();
  if (p.startsWith("/platform/auth/")) return true; // iniciar sesión + enrolar/verificar MFA
  if (OPERATOR_DENY_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"))) return false;
  const action = orgActionOf(p);
  if (action && OPERATOR_DENY_ORG_ACTIONS.some((a) => action === a || action.startsWith(a + "/"))) return false;
  return true;
}
