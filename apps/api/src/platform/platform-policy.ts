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
 * puede tocarlas. Nota: las acciones de billing POR-ORG viven bajo /platform/organizations
 * (billing-action, payment-link, subscription, invoices, wallet-adjust) y SÍ las puede el
 * operador; lo que se bloquea aquí es el billing/config GLOBAL de la plataforma.
 */
export const OPERATOR_DENY_PREFIXES = [
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
 * ¿Puede un OPERADOR acceder a esta ruta? true = permitido. Auth (login/MFA) siempre.
 * Coincidencia exacta o por segmento ("/platform/billing/..."), nunca por substring suelto,
 * para no bloquear rutas per-org que comparten raíz con una global.
 */
export function operatorMayAccess(rawPath: string): boolean {
  const p = (rawPath || "").split("?")[0].replace(/\/+$/, "") || "/";
  if (p.startsWith("/platform/auth/")) return true; // iniciar sesión + enrolar/verificar MFA
  return !OPERATOR_DENY_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
}
