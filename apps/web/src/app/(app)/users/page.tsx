"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Los usuarios ahora viven en Configuración (redirección para no romper enlaces). */
export default function UsersRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/users");
  }, [router]);
  return null;
}
