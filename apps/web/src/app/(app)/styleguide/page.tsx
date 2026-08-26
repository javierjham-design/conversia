"use client";

/**
 * Página de estilo (B2) — fuente única de la verdad del sistema de diseño.
 * Interna (solo para el equipo). Muestra en vivo tokens y componentes; usa el
 * toggle claro/oscuro del sidebar. Documentado en docs/DESIGN.md. Ruta:
 * /styleguide.
 */
import { useState } from "react";
import { Bell, Check, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Checkbox,
  DateInput,
  EmptyState,
  IconButton,
  Pagination,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
} from "@/components/ui";
import { AGENT_AVATARS, AgentAvatar } from "@/components/agent-avatars";

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-card border border-line bg-panel p-6 shadow-e1">
      <h2 className="t-section text-ink">{title}</h2>
      {hint && <p className="mt-0.5 t-body-sm text-ink-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="h-12 w-12 rounded-md border border-line" style={{ background: `var(${varName})` }} />
      <span className="t-meta text-ink-subtle">{name}</span>
    </div>
  );
}

const CAT = ["--color-cat-1", "--color-cat-2", "--color-cat-3", "--color-cat-4", "--color-cat-5", "--color-cat-6", "--color-cat-7", "--color-cat-8"];

export default function StyleguidePage() {
  const [check, setCheck] = useState(true);
  const [sw, setSw] = useState(true);
  const [page, setPage] = useState(1);
  const bars = [40, 65, 30, 80, 55, 70, 45]; // datos de ejemplo para el mini gráfico

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <p className="t-label uppercase tracking-wide text-brand-600 dark:text-brand-400">Sistema de diseño · interno</p>
        <h1 className="t-page mt-1 text-ink">Página de estilo</h1>
        <p className="mt-1 t-body text-ink-muted">
          Fuente única de la verdad. Cambia entre claro y oscuro con el botón del sidebar. Todo lo de aquí son tokens y
          componentes reales del producto (ver <code className="t-mono">docs/DESIGN.md</code>).
        </p>
      </header>

      {/* -------------------------------- Tipografía -------------------------------- */}
      <Section id="tipografia" title="Tipografía" hint="Inter (texto) + Sora (títulos). Cuerpo mínimo 14px, etiquetas 12px.">
        <div className="space-y-2 text-ink">
          <p className="t-display">Display · 30 · Sora 600</p>
          <p className="t-page">Título de página · 24 · Sora 600</p>
          <p className="t-section">Título de sección · 18 · Sora 600</p>
          <p className="t-card">Título de tarjeta · 15 · Inter 600</p>
          <p className="t-body">Cuerpo · 14 · Inter 400 — el tamaño base de lectura de toda la plataforma.</p>
          <p className="t-body-sm text-ink-muted">Cuerpo chico · 13 · para ayudas y metadatos secundarios.</p>
          <p className="t-label text-ink-muted">ETIQUETA · 12 · para campos de formulario</p>
          <p className="t-meta tnum text-ink-subtle">Meta · 11 · solo contadores y horas · 09:41 · 128</p>
          <p className="t-mono text-ink-muted">Mono · 13 · claves internas y código · phone_number_id</p>
        </div>
      </Section>

      {/* ---------------------------------- Color ---------------------------------- */}
      <Section id="color" title="Color" hint="Marca solo para la acción primaria. Datos y estados usan sus propias escalas.">
        <p className="t-label mb-2 text-ink-muted">Marca (brand) — escala 50→900</p>
        <div className="flex flex-wrap gap-3">
          {["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((n) => (
            <Swatch key={n} name={n} varName={`--color-brand-${n}`} />
          ))}
        </div>

        <p className="t-label mb-2 mt-5 text-ink-muted">Superficies (voltean en oscuro)</p>
        <div className="flex flex-wrap gap-3">
          <Swatch name="app" varName="--color-app" />
          <Swatch name="panel" varName="--color-panel" />
          <Swatch name="raised" varName="--color-raised" />
          <Swatch name="line" varName="--color-line" />
          <Swatch name="line-strong" varName="--color-line-strong" />
        </div>

        <p className="t-label mb-2 mt-5 text-ink-muted">Semánticos — con texto y tinte de fondo</p>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-pill border border-emerald-200 bg-emerald-50 px-2.5 py-1 t-meta font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">Éxito</span>
          <span className="rounded-pill border border-amber-300 bg-amber-50 px-2.5 py-1 t-meta font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">Atención</span>
          <span className="rounded-pill border border-red-200 bg-red-50 px-2.5 py-1 t-meta font-medium text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">Error</span>
          <span className="rounded-pill border border-sky-200 bg-sky-50 px-2.5 py-1 t-meta font-medium text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">Información</span>
        </div>

        <p className="t-label mb-2 mt-5 text-ink-muted">Paleta categórica — gráficos y etapas del ciclo de vida</p>
        <div className="flex flex-wrap gap-3">
          {CAT.map((v, i) => (
            <Swatch key={v} name={`cat-${i + 1}`} varName={v} />
          ))}
        </div>
      </Section>

      {/* ------------------------ Superficie y profundidad ------------------------ */}
      <Section id="superficie" title="Superficie y profundidad" hint="Tres niveles de elevación + radios en escala corta.">
        <div className="flex flex-wrap gap-4">
          <div className="rounded-card border border-line bg-app p-4 t-body-sm text-ink-muted">Base (contenedor)</div>
          <div className="rounded-card border border-line bg-raised p-4 shadow-e1 t-body-sm text-ink">Elevada (tarjeta) · e1</div>
          <div className="rounded-lg border border-line bg-raised p-4 shadow-e3 t-body-sm text-ink">Flotante (modal/popover) · e3</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {[["control", "rounded-control"], ["card", "rounded-card"], ["bubble", "rounded-bubble"], ["pill", "rounded-pill"]].map(([n, cls]) => (
            <div key={n} className={`border border-line-strong bg-panel px-3 py-2 t-meta text-ink-muted ${cls}`}>{n}</div>
          ))}
        </div>
      </Section>

      {/* -------------------------------- Botones -------------------------------- */}
      <Section id="botones" title="Botones" hint="Jerarquía real: un primario por pantalla. Con estados inequívocos.">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primario</Button>
          <Button variant="secondary">Secundario</Button>
          <Button variant="ghost">Fantasma</Button>
          <Button variant="danger"><Trash2 size={14} /> Destructivo</Button>
          <Button disabled>Deshabilitado</Button>
          <Button><Plus size={14} /> Con ícono</Button>
        </div>
        <p className="t-label mb-2 mt-4 text-ink-muted">Acciones de fila (IconButton)</p>
        <div className="flex items-center gap-1">
          <IconButton label="Editar"><Pencil size={15} /></IconButton>
          <IconButton label="Confirmar"><Check size={15} /></IconButton>
          <IconButton label="Eliminar" destructive><Trash2 size={15} /></IconButton>
        </div>
      </Section>

      {/* ------------------------------- Chips/estados ------------------------------- */}
      <Section id="chips" title="Chips y estados" hint="Un componente con variantes semánticas, un peso por variante.">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="connected" label="Conectado" />
          <StatusBadge kind="error" label="Error" />
          <StatusBadge kind="beta" label="Beta" />
          <StatusBadge kind="soon" label="Próximamente" />
        </div>
      </Section>

      {/* ------------------------------- Formularios ------------------------------- */}
      <Section id="formularios" title="Formularios" hint="Una sola altura de campo, etiqueta arriba, ayuda debajo.">
        <div className="grid max-w-lg gap-3">
          <label className="block">
            <span className="t-label text-ink-muted">Nombre del negocio</span>
            <input placeholder="p. ej. Clínica Norte" className="mt-1 w-full rounded-control border border-line-strong bg-panel px-3 py-2 t-body text-ink placeholder:text-ink-subtle" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="t-label text-ink-muted">Rubro</span>
              <span className="mt-1 block"><Select defaultValue="a" className="w-full"><option value="a">Clínica dental</option><option value="b">Retail</option></Select></span>
            </label>
            <label className="block">
              <span className="t-label text-ink-muted">Desde</span>
              <DateInput defaultValue="2026-08-25" className="mt-1 block w-full" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 t-body text-ink"><Checkbox checked={check} onChange={(e) => setCheck(e.target.checked)} /> Casilla</label>
            <label className="flex items-center gap-2 t-body text-ink opacity-60"><Checkbox disabled /> Deshabilitada</label>
            <Switch checked={sw} onChange={setSw} label="Interruptor" />
          </div>
        </div>
      </Section>

      {/* --------------------------------- Estados --------------------------------- */}
      <Section id="estados" title="Estados" hint="Hover, foco (anillo propio), seleccionado, cargando.">
        <div className="grid max-w-lg gap-2">
          <button className="rounded-control border border-line bg-panel px-3 py-2 text-left t-body text-ink transition-colors hover:bg-app">Fila — pasa el mouse (hover)</button>
          <button className="rounded-control border border-brand-400 bg-brand-50 px-3 py-2 text-left t-body text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">Fila — seleccionada</button>
          <div className="space-y-2 rounded-control border border-line bg-panel p-3">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </Section>

      {/* ------------------------- Paleta categórica en uso ------------------------- */}
      <Section id="datos" title="Datos con paleta categórica" hint="Series y etapas NUNCA usan el azul de marca.">
        <div className="flex items-end gap-1.5" style={{ height: 96 }}>
          {bars.map((v, i) => (
            <div key={i} className="flex-1 rounded-t" style={{ height: `${v}%`, background: `var(${CAT[i % CAT.length]})` }} />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {["Nuevo", "Contactado", "Calificado", "Agendado", "Ganado", "Perdido"].map((s, i) => (
            <span key={s} className="inline-flex items-center gap-1.5 t-body-sm text-ink-muted">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(${CAT[i % CAT.length]})` }} /> {s}
            </span>
          ))}
        </div>
      </Section>

      {/* ------------------------------ Estado vacío ------------------------------ */}
      <Section id="vacio" title="Estado vacío" hint="Ícono, título corto, una frase y una acción.">
        <EmptyState
          icon={<Bell size={22} />}
          title="Sin notificaciones"
          description="Cuando pase algo importante, lo verás acá."
          action={<Button variant="secondary">Configurar avisos</Button>}
        />
      </Section>

      {/* --------------------------- Avatares de agentes --------------------------- */}
      <Section id="avatares" title="Avatares de agentes de IA" hint="Biblioteca de 18: ícono de rol + color categórico. Reemplazan el selector de emoji.">
        <div className="flex flex-wrap gap-2">
          {AGENT_AVATARS.map((a) => (
            <AgentAvatar key={a.id} value={a.id} size="lg" />
          ))}
        </div>
      </Section>

      {/* ------------------------------ Paginación ------------------------------ */}
      <Section id="paginacion" title="Paginación">
        <Pagination page={page} pageSize={20} total={137} onPage={setPage} onPageSize={() => setPage(1)} itemLabel="clientes" />
      </Section>
    </div>
  );
}
