"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /settings → primera página del centro de configuración. */
export default function SettingsIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/general");
  }, [router]);
  return null;
}
