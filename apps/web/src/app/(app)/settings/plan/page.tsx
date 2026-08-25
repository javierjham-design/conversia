import { redirect } from "next/navigation";

/**
 * "Plan y uso" se unificó con "Plan y facturación" (/billing) — Bloque 1.3 de
 * la armonización: una sola página de plan, consumo, bolsa de mensajes y
 * facturas. La ruta queda como redirección para no romper enlaces guardados.
 */
export default function PlanSettingsRedirect() {
  redirect("/billing");
}
