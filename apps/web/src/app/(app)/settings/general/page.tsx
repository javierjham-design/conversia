"use client";

/** Información general del negocio (fuente de verdad: organization + settings.general). */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { withStringDefaults } from "@/lib/safe";
import { Button, Skeleton, useToast } from "@/components/ui";
import { ImageUpload } from "../image-upload";

interface GeneralSettings {
  name: string;
  slug: string;
  timezone: string;
  logoUrl: string;
  industry: string;
  currency: string;
  language: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
}

const GENERAL_DEFAULTS: GeneralSettings = {
  name: "", slug: "", timezone: "", logoUrl: "", industry: "",
  currency: "", language: "", contactEmail: "", contactPhone: "", website: "",
};

const TIMEZONES = [
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Lima",
  "America/Bogota",
  "America/Mexico_City",
  "America/Guayaquil",
  "America/La_Paz",
  "America/Asuncion",
  "America/Montevideo",
  "America/New_York",
  "Europe/Madrid",
];

const CURRENCIES = [
  ["CLP", "CLP — Peso chileno"],
  ["USD", "USD — Dólar"],
  ["ARS", "ARS — Peso argentino"],
  ["PEN", "PEN — Sol peruano"],
  ["COP", "COP — Peso colombiano"],
  ["MXN", "MXN — Peso mexicano"],
  ["EUR", "EUR — Euro"],
] as const;

const INDUSTRIES = ["Clínica dental", "Clínica médica", "Estética y belleza", "Educación", "Inmobiliaria", "Retail / e-commerce", "Servicios profesionales", "Otro"];

export default function GeneralSettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<GeneralSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Normaliza a cadenas: los campos opcionales pueden venir null desde la API
    // (tenant recién creado sin industria/web/contacto), lo que rompería inputs
    // controlados y `.trim()`.
    void api<Partial<GeneralSettings>>("/settings/general")
      .then((d) => setData(withStringDefaults(GENERAL_DEFAULTS, d)))
      .catch(() => setData(null));
  }, []);

  async function save() {
    if (!data) return;
    setBusy(true);
    try {
      await api("/settings/general", {
        method: "PUT",
        body: JSON.stringify({
          name: data.name,
          timezone: data.timezone,
          logoUrl: data.logoUrl || "",
          industry: data.industry,
          currency: data.currency,
          language: data.language,
          contactEmail: data.contactEmail || "",
          contactPhone: data.contactPhone,
          website: data.website || "",
        }),
      });
      toast.push("Información guardada ✔", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Skeleton className="h-64" />
      </div>
    );
  }

  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm";
  const set = (patch: Partial<GeneralSettings>) => setData({ ...data, ...patch });

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Información general</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Datos base del espacio de trabajo. La <b>zona horaria</b> la usan la agenda, los recordatorios, el resumen diario
        por correo y el nodo «Fecha y hora» de los flujos (como valor por defecto). La <b>moneda</b> es el default de los
        servicios nuevos (no cambia los precios ya definidos). El <b>idioma</b> lo usa el asistente IA del compositor.
      </p>

      <div className="mt-4 space-y-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Nombre del negocio</span>
            <input value={data.name} onChange={(e) => set({ name: e.target.value })} className={input} />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Rubro</span>
            <select value={data.industry} onChange={(e) => set({ industry: e.target.value })} className={`${input} bg-panel`}>
              <option value="">— elegir —</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Zona horaria</span>
            <select value={data.timezone} onChange={(e) => set({ timezone: e.target.value })} className={`${input} bg-panel`}>
              {TIMEZONES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Moneda por defecto</span>
            <select value={data.currency} onChange={(e) => set({ currency: e.target.value })} className={`${input} bg-panel`}>
              {CURRENCIES.map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Idioma por defecto</span>
            <select value={data.language} onChange={(e) => set({ language: e.target.value })} className={`${input} bg-panel`}>
              <option value="es">Español</option>
              <option value="en">Inglés</option>
              <option value="pt">Portugués</option>
            </select>
          </label>
          <div className="block text-sm">
            <span className="text-xs text-ink-muted">Logo del negocio</span>
            <div className="mt-1">
              <ImageUpload
                uploadPath="/settings/logo"
                servePath="/settings/logo"
                deletePath="/settings/logo"
                label="Logo"
                fallbackUrl={data.logoUrl || undefined}
              />
            </div>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <p className="text-xs font-medium text-ink-muted">Datos de contacto del negocio</p>
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Email</span>
              <input value={data.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} className={input} />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Teléfono</span>
              <input value={data.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} className={input} />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Sitio web</span>
              <input value={data.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://…" className={input} />
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line pt-3">
          
          <Button onClick={() => void save()} disabled={busy || data.name.trim().length < 2}>Guardar cambios</Button>
        </div>
      </div>
    </div>
  );
}
