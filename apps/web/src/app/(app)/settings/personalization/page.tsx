"use client";

/** Rubro y personalización: vocabulario por industria, módulos visibles y plantillas. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Checkbox, Select, Skeleton, useToast } from "@/components/ui";
import { recommendedFor } from "@/lib/industry-templates";

interface Personalization {
  industry: string;
  industries: { code: string; label: string }[];
  vocabulary: Record<string, string>;
  base: Record<string, string>;
  overrides: Record<string, string>;
  modules: Record<string, boolean>;
}

const TERMS: { key: string; label: string }[] = [
  { key: "contact", label: "Contacto (singular)" },
  { key: "contacts", label: "Contactos (plural)" },
  { key: "service", label: "Servicio" },
  { key: "services", label: "Servicios" },
  { key: "professional", label: "Miembro del equipo" },
  { key: "professionals", label: "Equipo (plural)" },
  { key: "appointment", label: "Cita" },
  { key: "appointments", label: "Citas" },
  { key: "branch", label: "Sucursal (singular)" },
  { key: "branches", label: "Sucursales (plural)" },
];

export default function PersonalizationPage() {
  const toast = useToast();
  const router = useRouter();
  const [p, setP] = useState<Personalization | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = () =>
    api<Personalization>("/settings/personalization").then((r) => {
      setP(r);
      setOverrides(r.overrides ?? {});
    });
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveIndustry(industry: string) {
    setBusy(true);
    try {
      await api("/settings/personalization", { method: "PUT", body: JSON.stringify({ industry }) });
      await load();
      toast.push("Rubro actualizado ✔ (recarga para ver las etiquetas nuevas)", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveVocab() {
    setBusy(true);
    try {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(overrides)) if (v.trim()) clean[k] = v.trim();
      await api("/settings/personalization", { method: "PUT", body: JSON.stringify({ vocabulary: clean }) });
      await load();
      toast.push("Vocabulario guardado ✔ (recarga para verlo en el menú)", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleModule(key: string, enabled: boolean) {
    setBusy(true);
    try {
      await api("/settings/personalization", { method: "PUT", body: JSON.stringify({ modules: { [key]: enabled } }) });
      await load();
      toast.push("Módulos actualizados ✔ (recarga para ver el menú)", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function installFlows() {
    if (!p) return;
    const { flows } = recommendedFor(p.industry);
    if (!confirm(`Se crearán ${flows.length} flujo(s) como BORRADOR para que los revises y publiques. ¿Continuar?`)) return;
    setInstalling(true);
    try {
      let ok = 0;
      for (const f of flows) {
        const wf = await api<{ id: string }>("/workflows", { method: "POST", body: JSON.stringify({ name: f.name, description: f.description }) });
        await api(`/workflows/${wf.id}/draft`, { method: "PUT", body: JSON.stringify({ name: f.name, definition: f.definition }) });
        ok++;
      }
      toast.push(`${ok} flujo(s) instalados como borrador ✔`, "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setInstalling(false);
    }
  }

  if (!p) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;
  const sel = "mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm";
  const rec = recommendedFor(p.industry);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Rubro y personalización</h2>
      <p className="mt-1 text-xs text-ink-muted">Al elegir tu rubro, la plataforma adapta el vocabulario, los módulos visibles y las plantillas sugeridas.</p>

      {/* Rubro */}
      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <label className="block text-sm">
          <span className="font-medium">Rubro / industria</span>
          <Select className="mt-1 w-full" value={p.industry} disabled={busy} onChange={(e) => void saveIndustry(e.target.value)}>
            {p.industries.map((i) => (<option key={i.code} value={i.code}>{i.label}</option>))}
          </Select>
          <span className="mt-1 block text-[11px] text-ink-subtle">Cambia el vocabulario y los módulos por defecto. Tus ajustes manuales se conservan.</span>
        </label>
      </div>

      {/* Vocabulario */}
      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Vocabulario</p>
        <p className="mt-1 text-xs text-ink-muted">Cómo llamas a las cosas en tu negocio. Vacío = usa el valor por defecto de tu rubro (entre paréntesis).</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {TERMS.map((t) => (
            <label key={t.key} className="block text-sm">
              <span className="text-xs text-ink-muted">{t.label}</span>
              <input
                value={overrides[t.key] ?? ""}
                placeholder={p.vocabulary[t.key] ?? p.base[t.key] ?? ""}
                onChange={(e) => setOverrides({ ...overrides, [t.key]: e.target.value })}
                className={sel}
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={() => void saveVocab()} disabled={busy}>Guardar cambios</Button>
        </div>
      </div>

      {/* Módulos */}
      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Módulos visibles</p>
        <p className="mt-1 text-xs text-ink-muted">Oculta del menú lo que no usas. No borra datos ni rompe rutas.</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <Checkbox checked={p.modules.agenda !== false} disabled={busy} onChange={(e) => void toggleModule("agenda", e.target.checked)} />
          Mostrar <b>Agenda</b> (citas / reservas)
        </label>
      </div>

      {/* Plantillas por rubro */}
      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Plantillas recomendadas para tu rubro</p>
        <div className="mt-2 space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium text-ink-muted">Agentes IA</p>
            <ul className="ml-4 list-disc text-ink-muted">
              {rec.agents.map((a) => (<li key={a.key}>{a.emoji} {a.name} — <span className="text-ink-subtle">{a.description}</span></li>))}
            </ul>
            <Button variant="secondary" className="mt-1" onClick={() => router.push("/agents")}>Crear agente desde la galería →</Button>
          </div>
          <div className="pt-2">
            <p className="text-xs font-medium text-ink-muted">Flujos</p>
            <ul className="ml-4 list-disc text-ink-muted">
              {rec.flows.map((f) => (<li key={f.key}>{f.name} — <span className="text-ink-subtle">{f.description}</span></li>))}
            </ul>
            <Button className="mt-1" onClick={() => void installFlows()} disabled={installing}>
              {installing ? "Instalando…" : `Instalar ${rec.flows.length} flujo(s) como borrador`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
