"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Los equipos se administran junto a los usuarios. */
export default function TeamsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/users#equipos");
  }, [router]);
  return null;
}
