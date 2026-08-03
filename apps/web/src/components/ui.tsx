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
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-control px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-e1",
    secondary: "border border-line-strong bg-panel text-ink hover:bg-app",
    ghost: "text-ink-muted hover:bg-app",
    danger: "border border-red-300 bg-panel text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10",
  };
  return <button className={cn(base, variants[variant], className)} {...props} />;
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
    ok: "text-emerald-600",
    warn: "text-amber-600",
    danger: "text-red-600",
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
  attention: { label: "Requiere atención", className: "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30", Icon: AlertTriangle },
  error: { label: "Error", className: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30", Icon: XCircle },
  disconnected: { label: "Desconectada", className: "bg-app text-ink-muted border-line", Icon: PauseCircle },
  soon: { label: "Próximamente", className: "bg-app text-ink-muted border-line", Icon: Clock },
  beta: { label: "Beta", className: "bg-accent-500/10 text-accent-600 border-accent-500/30", Icon: Sparkles },
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
      <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cn("relative max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-line bg-raised p-6 text-ink shadow-e3", wide ? "max-w-3xl" : "max-w-lg")}>
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
      <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-raised text-ink shadow-e3">
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
