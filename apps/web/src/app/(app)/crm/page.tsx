"use client";

/**
 * El CRM se unificó con el módulo de personas (B1.1 de la armonización):
 * /contacts tiene las dos vistas (Tabla y Tablero) con un solo buscador,
 * paginador, sidebar y ficha. Esta ruta queda como redirección para no romper
 * enlaces guardados ni el ítem del menú.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CrmRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/contacts?vista=tablero");
  }, [router]);
  return null;
}
