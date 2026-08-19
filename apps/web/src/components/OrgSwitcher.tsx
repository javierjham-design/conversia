"use client";

import { useEffect, useState } from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { api, setToken } from "@/lib/api";

interface Org {
  id: string;
  name: string;
  slug: string;
  status: string;
  roleCode: string;
}

/**
 * Selector de tenant: un mismo usuario puede pertenecer a varias organizaciones.
 * Al elegir otra, pide un token nuevo para ese tenant y recarga el panel.
 */
export function OrgSwitcher({ currentName }: { currentName?: string | null }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    void api<{ organizations: Org[]; current: string }>("/auth/organizations")
      .then((r) => {
        setOrgs(r.organizations);
        setCurrent(r.current);
      })
      .catch(() => undefined);
  }, []);

  const currentOrg = orgs?.find((o) => o.id === current);
  const name = currentOrg?.name ?? currentName ?? "Organización";
  const multi = (orgs?.length ?? 0) > 1;

  async function switchTo(id: string) {
    if (id === current) {
      setOpen(false);
      return;
    }
    setSwitching(id);
    try {
      const res = await api<{ token: string }>("/auth/switch", { method: "POST", body: JSON.stringify({ organizationId: id }) });
      setToken(res.token);
      // Recarga completa: todos los datos se recargan para el nuevo tenant.
      window.location.href = "/inbox";
    } catch {
      setSwitching(null);
    }
  }

  // Un solo tenant (o aún cargando): tarjeta estática, como antes.
  if (!multi) {
    return (
      <div className="mx-3 mb-2 rounded-lg bg-navy-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Building2 size={14} className="shrink-0 text-accent-400" />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-medium text-white">{name}</p>
            <p className="text-[10px] uppercase tracking-wide text-navy-300">Organización</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-3 mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg bg-navy-800 px-3 py-2 text-left hover:bg-navy-700"
      >
        <Building2 size={14} className="shrink-0 text-accent-400" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium text-white">{name}</p>
          <p className="text-[10px] uppercase tracking-wide text-navy-300">Cambiar organización</p>
        </div>
        <ChevronsUpDown size={14} className="shrink-0 text-navy-300" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-navy-700 bg-navy-900 p-1 shadow-2xl">
            {orgs!.map((o) => (
              <button
                key={o.id}
                onClick={() => void switchTo(o.id)}
                disabled={switching !== null}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-navy-100 hover:bg-navy-800 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-white">{o.name}</span>
                  <span className="block text-[10px] uppercase tracking-wide text-navy-400">{o.roleCode}</span>
                </span>
                {o.id === current ? (
                  <Check size={14} className="shrink-0 text-accent-400" />
                ) : switching === o.id ? (
                  <span className="text-[10px] text-navy-300">…</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
