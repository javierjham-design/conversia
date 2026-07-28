import Link from "next/link";

/**
 * Botón/enlace a la página de solicitud de demo (/demo). Reemplaza el modal por
 * una página dedicada (mejor UX + registro claro). Pasa el plan de interés.
 */
export function DemoCta({ label, planCode, className }: { label: string; planCode?: string; className?: string }) {
  const href = planCode ? `/demo?plan=${encodeURIComponent(planCode)}` : "/demo";
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}
