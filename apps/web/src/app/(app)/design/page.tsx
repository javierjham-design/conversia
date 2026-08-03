"use client";

/**
 * Página de muestra del sistema de diseño (docs/DESIGN.md). No es funcional:
 * sirve para validar tokens, tipografía, superficies, controles y burbujas en
 * modo claro y oscuro (usa el toggle del sidebar). Ruta: /design.
 */
import { Bot, Clock, Paperclip, Send, Smile, Sparkles } from "lucide-react";
import { Button } from "@/components/ui";

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-12 w-12 rounded-control border border-line ${className}`} />
      <span className="text-2xs text-ink-subtle">{name}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-panel p-5 shadow-e1">
      <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Sistema de diseño</h1>
        <p className="mt-1 text-13 text-ink-muted">
          Página de muestra — cambia entre claro y oscuro con el botón del sidebar. Estos tokens y componentes son la
          base del rediseño de la Bandeja.
        </p>
      </div>

      <Section title="Marca (brand) — único primario, escala 50→900">
        <div className="flex flex-wrap gap-3">
          {[
            ["50", "bg-brand-50"], ["100", "bg-brand-100"], ["200", "bg-brand-200"], ["300", "bg-brand-300"], ["400", "bg-brand-400"],
            ["500", "bg-brand-500"], ["600", "bg-brand-600"], ["700", "bg-brand-700"], ["800", "bg-brand-800"], ["900", "bg-brand-900"],
          ].map(([name, cls]) => (
            <Swatch key={name} name={name} className={cls} />
          ))}
        </div>
      </Section>

      <Section title="Superficies (voltean en oscuro)">
        <div className="flex flex-wrap gap-3">
          <Swatch name="app" className="bg-app" />
          <Swatch name="panel" className="bg-panel" />
          <Swatch name="raised" className="bg-raised shadow-e2" />
          <Swatch name="brand-soft" className="bg-brand-soft" />
          <Swatch name="line" className="bg-line" />
        </div>
      </Section>

      <Section title="Semánticos — acotados (ámbar = solo atención requerida)">
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-2xs font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">Éxito</span>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-2xs font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 ">Atención</span>
          <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-2xs font-medium text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">Error</span>
          <span className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-2xs font-medium text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">Info</span>
        </div>
      </Section>

      <Section title="Tipografía — 11 / 12 / 13 / 14 / 16 / 20, pesos 400·500·600">
        <div className="space-y-1 text-ink">
          <p className="text-xl font-semibold">20/600 · Título de sección</p>
          <p className="text-base font-semibold">16/600 · Nombre en cabecera de conversación</p>
          <p className="text-sm font-semibold">14/600 · Nombre en la lista</p>
          <p className="text-13 text-ink-muted">13/400 · Ítem del sidebar / preview</p>
          <p className="text-xs text-ink-muted">12/400 · Teléfono, canal, ayuda</p>
          <p className="text-2xs tnum text-ink-subtle">11/400 · Metadatos y contadores tabulares · 09:41 · 128</p>
        </div>
      </Section>

      <Section title="Controles — estados unificados (hover/focus/active/disabled)">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primario</Button>
          <Button variant="secondary">Secundario</Button>
          <Button variant="ghost">Fantasma</Button>
          <Button variant="danger">Peligro</Button>
          <Button disabled>Deshabilitado</Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input placeholder="Input de texto…" className="rounded-control border border-line-strong bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-subtle" />
          <select className="rounded-control border border-line-strong bg-panel px-3 py-2 text-sm text-ink">
            <option>Selector</option>
          </select>
        </div>
      </Section>

      <Section title="Burbujas del hilo (menos saturadas, radio 16px)">
        <div className="space-y-2">
          <div className="flex justify-start">
            <div className="max-w-[62ch] rounded-bubble rounded-bl-md border border-line bg-raised px-4 py-2 text-sm text-ink shadow-e1">
              Hola, ¿tienen hora disponible esta semana?
              <span className="mt-1 block text-2xs text-ink-subtle">María Pérez · 09:41</span>
            </div>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[62ch] rounded-bubble rounded-br-md bg-brand-600 px-4 py-2 text-sm text-white shadow-e1">
              ¡Hola María! Sí, tenemos el martes a las 15:00. ¿Te sirve?
              <span className="mt-1 block text-2xs text-white/70">🤖 IA · 09:42 · ✓✓</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Chips y utilidades">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <Clock size={11} /> Ventana 24 h · 18 h
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-2xs font-medium text-brand-700 dark:text-brand-300">
            <Bot size={11} /> IA
          </span>
          <span className="live-dot inline-block h-2 w-2 rounded-full bg-emerald-500" title="En vivo" />
          <span className="text-2xs text-ink-subtle">en vivo</span>
          <div className="h-6 w-40 shimmer rounded-control bg-line" />
        </div>
      </Section>

      <Section title="Barra de herramientas del compositor (set cohesivo)">
        <div className="flex flex-wrap items-center gap-1 rounded-control border border-line bg-app p-1">
          <button className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:bg-panel hover:text-ink"><Sparkles size={12} /> Sugerir</button>
          <button className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:bg-panel hover:text-ink">Mejorar</button>
          <button className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:bg-panel hover:text-ink">Traducir</button>
          <button className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:bg-panel hover:text-ink">Resumir</button>
          <span className="mx-1 h-4 w-px bg-line" />
          <button className="rounded-control p-1.5 text-ink-subtle hover:bg-panel hover:text-ink"><Smile size={16} /></button>
          <button className="rounded-control p-1.5 text-ink-subtle hover:bg-panel hover:text-ink"><Paperclip size={16} /></button>
          <button className="ml-auto inline-flex items-center gap-1 rounded-control bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"><Send size={14} /> Enviar</button>
        </div>
      </Section>
    </div>
  );
}
