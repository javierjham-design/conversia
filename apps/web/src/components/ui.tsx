"use client";

/**
 * Componentes base de TuBot — sistema visual compartido.
 * Sin dependencias más allá de lucide-react.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  PauseCircle,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------- Botones -------------------------------

export function Button({
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  // Deshabilitado INEQUÍVOCO (B4.5): gris, sin sombra, cursor bloqueado — nunca
  // un primario "clarito" que se confunda con uno habilitado.
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-control px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed";
  const variants = {
    primary:
      "bg-brand-600 text-white hover:bg-brand-700 shadow-e1 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-slate-700 dark:disabled:text-slate-500",
    secondary:
      "border border-line-strong bg-panel text-ink hover:bg-app disabled:border-line disabled:bg-app disabled:text-ink-subtle",
    ghost: "text-ink-muted hover:bg-app disabled:text-ink-subtle disabled:hover:bg-transparent",
    danger:
      "border border-red-300 bg-panel text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10 disabled:border-line disabled:bg-app disabled:text-ink-subtle",
  };
  return <button className={cn(base, variants[variant], className)} {...props} />;
}

/**
 * Acción de fila unificada (B5.6): icono + tooltip. `destructive` la pinta en
 * rojo al pasar el cursor. Reemplaza los «✕»/«Editar» sueltos por un patrón
 * único en todas las listas (Editar/Duplicar/Eliminar).
 */
export function IconButton({
  label,
  destructive,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; destructive?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "rounded-control p-1.5 text-ink-subtle transition-colors disabled:cursor-not-allowed disabled:opacity-30",
        destructive ? "hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400" : "hover:bg-app hover:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// -------------------- Controles de formulario propios --------------------
// (B4: reemplazan a los controles nativos sin estilo — mismo alto, radio,
// tipografía, foco y modo oscuro en toda la app.)

/** Select del design system: envuelve el <select> nativo (teclado y a11y
 *  gratis) con estilo unificado y chevron propio. */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn("relative inline-flex", className?.includes("w-full") && "w-full")}>
      <select
        className={cn(
          "appearance-none rounded-control border border-line-strong bg-panel py-1.5 pl-3 pr-8 text-sm text-ink transition-colors",
          "hover:border-line-strong focus:border-brand-500 disabled:cursor-not-allowed disabled:bg-app disabled:text-ink-subtle",
          className,
        )}
        {...props}
      />
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Checkbox del design system — para SELECCIONAR de una lista. */
export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-4 w-4 shrink-0 cursor-pointer appearance-none rounded border border-line-strong bg-panel transition-colors",
        "checked:border-brand-600 checked:bg-brand-600 checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M3.5 8.5l3 3 6-7%22/></svg>')] checked:bg-center checked:bg-no-repeat",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

/** Switch del design system — para ACTIVAR una capacidad (on/off). */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-600",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

/** Input de fecha del design system (nativo estilizado; formato del navegador
 *  es-CL, con color-scheme correcto en oscuro). */
export function DateInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="date"
      className={cn(
        "rounded-control border border-line-strong bg-panel px-3 py-1.5 text-sm text-ink transition-colors [color-scheme:light] dark:[color-scheme:dark]",
        "focus:border-brand-500 disabled:cursor-not-allowed disabled:bg-app disabled:text-ink-subtle",
        className,
      )}
      {...props}
    />
  );
}

/** Paginación única de la plataforma: «N / página» + Anterior/Siguiente. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  itemLabel = "registros",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize?: (n: number) => void;
  itemLabel?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
      <div className="flex items-center gap-2">
        <span className="tnum">{total.toLocaleString("es-CL")} {itemLabel}</span>
        {onPageSize && (
          <Select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Tamaño de página">
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>{n} / página</option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="secondary" className="px-2.5 py-1" disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>Anterior</Button>
        <span className="px-2 tnum">Página {page} de {totalPages}</span>
        <Button variant="secondary" className="px-2.5 py-1" disabled={page >= totalPages} onClick={() => onPage(Math.min(totalPages, page + 1))}>Siguiente</Button>
      </div>
    </div>
  );
}

// ---------------------------- Encabezados ----------------------------

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-[15px] text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// ------------------------------ Métricas ------------------------------

export function MetricCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "warn" | "danger" | "ok";
  icon?: React.ReactNode;
}) {
  const tones = {
    default: "text-ink",
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  };
  return (
    <div className="rounded-card border border-line bg-panel p-4 shadow-e1">
      <div className="flex items-center justify-between">
        <p className="text-13 font-medium text-ink-muted">{label}</p>
        {icon && <span className="text-ink-subtle">{icon}</span>}
      </div>
      <p className={cn("mt-1 text-2xl font-semibold", tones[tone])}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}

// --------------------------- Badges de estado ---------------------------

export type StatusKind =
  | "connected"
  | "syncing"
  | "incomplete"
  | "attention"
  | "error"
  | "disconnected"
  | "soon"
  | "beta"
  | "mock";

const STATUS_META: Record<StatusKind, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  connected: { label: "Conectada", className: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30", Icon: CheckCircle2 },
  syncing: { label: "Sincronizando", className: "bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/30", Icon: Loader2 },
  incomplete: { label: "Configuración incompleta", className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30", Icon: AlertTriangle },
  attention: { label: "Requiere atención", className: "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30 ", Icon: AlertTriangle },
  error: { label: "Error", className: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30", Icon: XCircle },
  disconnected: { label: "Desconectada", className: "bg-app text-ink-muted border-line", Icon: PauseCircle },
  soon: { label: "Próximamente", className: "bg-app text-ink-muted border-line", Icon: Clock },
  beta: { label: "Beta", className: "bg-accent-500/10 text-accent-600 border-accent-500/30 dark:text-accent-400", Icon: Sparkles },
  mock: { label: "Simulación (dev)", className: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/30", Icon: Circle },
};

export function StatusBadge({ kind, label }: { kind: StatusKind; label?: string }) {
  const meta = STATUS_META[kind];
  const Icon = meta.Icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", meta.className)}>
      <Icon size={12} className={kind === "syncing" ? "animate-spin" : ""} aria-hidden />
      {label ?? meta.label}
    </span>
  );
}

export function HealthDot({ level }: { level: "ok" | "warn" | "error" | "off" }) {
  const map = {
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    error: "bg-red-500",
    off: "bg-line-strong",
  };
  return <span className={cn("inline-block h-2.5 w-2.5 rounded-full", map[level])} aria-hidden />;
}

// --------------------------- Estados vacíos ---------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-panel/50 px-6 py-10 text-center">
      {icon && <div className="mb-2 text-ink-subtle">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-control bg-line", className)} />;
}

// ------------------------------- Tabs -------------------------------

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; badge?: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
            active === t.id
              ? "border-brand-600 text-brand-700 dark:text-brand-300"
              : "border-transparent text-ink-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.badge && <span className="ml-1.5 rounded-full bg-line px-1.5 text-[10px] text-ink-muted">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

// --------------------------- Modal y Drawer ---------------------------

export function Modal({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="animate-overlay-in absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cn("animate-modal-in relative max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-raised p-6 text-ink shadow-e3", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="mb-4 flex items-center justify-between">
          {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
          <button onClick={onClose} aria-label="Cerrar" className="rounded-control p-1 text-ink-subtle hover:bg-app hover:text-ink">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div className="animate-overlay-in absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-drawer-in absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-raised text-ink shadow-e3">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-raised px-5 py-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button onClick={onClose} aria-label="Cerrar" className="rounded-control p-1 text-ink-subtle hover:bg-app hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirmar",
  danger,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {description && <p className="mb-4 text-sm text-ink-muted">{description}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => { onConfirm(); onClose(); }}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------- Campo secreto ----------------------------

export function SecretField({ value, label }: { value: string; label?: string }) {
  const [show, setShow] = useState(false);
  const toast = useToast();
  return (
    <div>
      {label && <p className="mb-1 text-xs font-medium text-ink-muted">{label}</p>}
      <div className="flex items-center gap-1 rounded-control border border-line bg-app px-3 py-2 font-mono text-xs text-ink">
        <span className="flex-1 truncate">{show ? value : "•".repeat(Math.min(value.length, 28))}</span>
        <button onClick={() => setShow(!show)} aria-label={show ? "Ocultar" : "Mostrar"} className="p-1 text-ink-subtle hover:text-ink">
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.push("Copiado al portapapeles", "ok");
          }}
          aria-label="Copiar"
          className="p-1 text-ink-subtle hover:text-ink"
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------- Toasts -------------------------------

interface ToastItem {
  id: number;
  text: string;
  kind: "ok" | "error" | "info";
}
const ToastContext = createContext<{ push: (text: string, kind?: ToastItem["kind"]) => void }>({ push: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-card border bg-raised p-3 text-sm shadow-e3",
              t.kind === "ok" && "border-emerald-300 dark:border-emerald-500/40",
              t.kind === "error" && "border-red-300 dark:border-red-500/40",
              t.kind === "info" && "border-line",
            )}
          >
            {t.kind === "ok" ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
            ) : t.kind === "error" ? (
              <XCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
            ) : (
              <Circle size={16} className="mt-0.5 shrink-0 text-ink-subtle" />
            )}
            <span className="text-ink">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
