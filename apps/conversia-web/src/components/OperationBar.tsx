"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Lock, Plus, Settings2, Tag as TagIcon, UserRound, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * B1 — Barra de operación del chat (DISEÑO §6).
 * Chips sobre el hilo (desktop ≥620px) para operar la conversación sin salir de la Bandeja:
 * Agente de IA · Asignada a · Etapa · Etiquetas. En móvil (<620px) un botón "Gestionar"
 * abre un sheet inferior con los mismos controles.
 *
 * Todo con el design system "Nocturna" (vars CSS, sin Tailwind, sin emojis como ícono — lucide).
 * Las mutaciones son optimistas con rollback: si la API falla se restaura el estado previo y
 * se emite el error; tras éxito refrescamos la lista (onChanged) para que persista al recargar.
 */

export type OpStage = { code: string; name: string; color: string | null; emoji: string | null } | null;

export type OpState = {
  conversationId: string;
  contactId: string;
  aiEnabled: boolean;
  activeAgentId: string | null;
  activeAgentName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  stage: OpStage;
  /** Nombres de etiquetas ya asignadas al contacto (del /context). */
  tags: string[];
  /** Ventana de 24h (último INBOUND). null = aún sin entrantes. */
  windowOpen: boolean | null;
  /** Horas restantes dentro de la ventana (solo si windowOpen). */
  windowHoursLeft: number | null;
};

type AssignableAgent = { id: string; name: string; slug: string };
type AssignableUser = { userId: string; name: string };
type StageOption = { code: string; name: string; color: string | null; emoji: string | null };
type TagRow = { id: string; name: string; color: string | null };

const CHIP: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 11px",
  minHeight: 34,
  borderRadius: 999,
  border: "1px solid var(--line)",
  background: "var(--surface-solid)",
  color: "var(--ink)",
  cursor: "pointer",
  fontSize: 12,
  maxWidth: 240,
};

function chipLabelStyle(): React.CSSProperties {
  return { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 };
}

/** Punto de color de etapa (o acento si no trae color). */
function Dot({ color }: { color?: string | null }) {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: color || "var(--acc)", flexShrink: 0 }} />;
}

export function OperationBar({ state, narrow, onChanged }: { state: OpState; narrow: boolean; onChanged: () => void }) {
  const [sheetOpen, setSheetOpen] = useState(false);

  // La barra reparte el mismo bloque de chips entre desktop (en línea) y móvil (dentro del sheet).
  const chips = <OperationChips state={state} onChanged={onChanged} stacked={narrow} />;

  const windowPill = <WindowPill open={state.windowOpen} hoursLeft={state.windowHoursLeft} />;

  if (narrow) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
          {windowPill}
          <button
            onClick={() => setSheetOpen(true)}
            style={{ ...CHIP, marginLeft: "auto", minHeight: 44, borderColor: "var(--acc)", color: "var(--acc-deep)", fontWeight: 600 }}
          >
            <Settings2 size={15} /> Gestionar
          </button>
        </div>
        {sheetOpen ? (
          <Sheet onClose={() => setSheetOpen(false)} title="Gestionar conversación">
            {chips}
          </Sheet>
        ) : null}
      </>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
      {windowPill}
      <span style={{ width: 1, height: 20, background: "var(--hairline)", margin: "0 2px" }} aria-hidden />
      {chips}
    </div>
  );
}

/** Píldora de ventana de 24h re-estilada: punto ok/warn + candado (Lock) si está cerrada. */
function WindowPill({ open, hoursLeft }: { open: boolean | null; hoursLeft: number | null }) {
  if (open === null) return null;
  return (
    <span
      title={open ? "Dentro de la ventana de 24h: puedes responder con texto libre." : "Fuera de la ventana de 24h: solo plantillas aprobadas."}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        minHeight: 30,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        border: `1px solid ${open ? "var(--ok)" : "var(--warn)"}`,
        color: open ? "var(--ok)" : "var(--warn)",
        background: "transparent",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: open ? "var(--ok)" : "var(--warn)", flexShrink: 0 }} />
      {open ? `24h · ${Math.max(0, Math.floor(hoursLeft ?? 0))}h` : <><Lock size={12} /> fuera de 24h</>}
    </span>
  );
}

function OperationChips({ state, onChanged, stacked }: { state: OpState; onChanged: () => void; stacked: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const wrap: React.CSSProperties = stacked
    ? { display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }
    : { display: "contents" };

  return (
    <div style={wrap}>
      <AgentChip state={state} onChanged={onChanged} onError={setError} stacked={stacked} />
      <AssignChip state={state} onChanged={onChanged} onError={setError} stacked={stacked} />
      <StageChip state={state} onChanged={onChanged} onError={setError} stacked={stacked} />
      <TagsChip state={state} onChanged={onChanged} onError={setError} stacked={stacked} />
      {error ? <span style={{ color: "var(--danger)", fontSize: 11, flexBasis: "100%" }}>{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Popover genérico (desktop) / bloque inline (móvil, dentro del sheet).
// ---------------------------------------------------------------------------
function Popover({
  trigger,
  stacked,
  children,
  label,
}: {
  trigger: React.ReactNode;
  stacked: boolean;
  children: (close: () => void) => React.ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // En el sheet móvil mostramos el control expandido en lugar de un popover flotante.
  if (stacked) {
    return (
      <div>
        <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-dim)" }}>{label}</p>
        <div className="card" style={{ padding: 6, maxHeight: 220, overflowY: "auto" }}>{children(() => {})}</div>
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open ? (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={close} />
          <div
            className="card"
            role="menu"
            aria-label={label}
            style={{ position: "absolute", left: 0, top: 42, zIndex: 50, width: 260, maxHeight: 320, overflowY: "auto", padding: 6, boxShadow: "0 12px 32px rgba(0,0,0,0.28)" }}
          >
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Fila seleccionable dentro de un popover/sheet (target ≥44px en móvil). */
function Row({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        minHeight: 44,
        padding: "8px 10px",
        borderRadius: 10,
        border: "none",
        cursor: "pointer",
        fontSize: 13,
        background: active ? "var(--acc-dim)" : "transparent",
        color: "var(--ink)",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chip: Agente de IA  → GET /agents/assignable → POST /conversations/:id/agent
// ---------------------------------------------------------------------------
function AgentChip({ state, onChanged, onError, stacked }: ChipProps) {
  const [agents, setAgents] = useState<AssignableAgent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const label = state.aiEnabled ? (state.activeAgentName ?? "Sin agente") : "Manual";
  const dimmed = !state.aiEnabled; // en manual el chip va atenuado (la IA está pausada)

  async function pick(agentId: string | null, close: () => void) {
    close();
    if (busy) return;
    if (agentId === state.activeAgentId && (agentId ? state.aiEnabled : !state.aiEnabled)) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/conversations/${state.conversationId}/agent`, { method: "POST", body: JSON.stringify({ agentId }) });
      onChanged();
    } catch (e) {
      onError((e as Error).message); // sin mutación local → "rollback" implícito (la lista manda)
    } finally {
      setBusy(false);
    }
  }

  const trigger = (
    <button style={{ ...CHIP, opacity: dimmed ? 0.55 : busy ? 0.6 : 1, width: stacked ? "100%" : undefined, justifyContent: stacked ? "space-between" : undefined }} title="Agente de IA a cargo">
      <Bot size={14} className="text-dim" />
      <span className="text-dim" style={{ flexShrink: 0 }}>Agente:</span>
      <b style={chipLabelStyle()}>{label}</b>
      <ChevronDown size={13} className="text-dim" />
    </button>
  );

  return (
    <Popover label="Agente de IA" stacked={stacked} trigger={trigger}>
      {(close) => (
        <Loader load={() => api<AssignableAgent[]>("/agents/assignable")} value={agents} setValue={setAgents}>
          {(list) => (
            <>
              {list.map((a) => (
                <Row key={a.id} active={state.aiEnabled && state.activeAgentId === a.id} onClick={() => pick(a.id, close)}>
                  <Bot size={14} className="text-dim" />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
                  {state.aiEnabled && state.activeAgentId === a.id ? <Check size={14} style={{ color: "var(--acc-deep)" }} /> : null}
                </Row>
              ))}
              <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
              <Row active={!state.aiEnabled} onClick={() => pick(null, close)}>
                <span className="text-dim" style={{ flex: 1 }}>Desactivar IA (manual)</span>
                {!state.aiEnabled ? <Check size={14} style={{ color: "var(--acc-deep)" }} /> : null}
              </Row>
              {list.length === 0 ? <p className="text-dim" style={{ fontSize: 12, padding: "8px 10px", margin: 0 }}>No hay agentes publicados.</p> : null}
            </>
          )}
        </Loader>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Chip: Asignada a  → GET /users/assignable → POST /conversations/:id/assign
// ---------------------------------------------------------------------------
function AssignChip({ state, onChanged, onError, stacked }: ChipProps) {
  const [users, setUsers] = useState<AssignableUser[] | null>(null);
  const [busy, setBusy] = useState(false);
  const label = state.assignedUserName ?? "Sin asignar";

  async function pick(userId: string | null, close: () => void) {
    close();
    if (busy || userId === state.assignedUserId) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/conversations/${state.conversationId}/assign`, { method: "POST", body: JSON.stringify({ userId }) });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const trigger = (
    <button style={{ ...CHIP, opacity: busy ? 0.6 : 1, width: stacked ? "100%" : undefined, justifyContent: stacked ? "space-between" : undefined }} title="Responsable de la conversación">
      <UserRound size={14} className="text-dim" />
      <span className="text-dim" style={{ flexShrink: 0 }}>Asignada a:</span>
      <b style={chipLabelStyle()}>{label}</b>
      <ChevronDown size={13} className="text-dim" />
    </button>
  );

  return (
    <Popover label="Asignar a" stacked={stacked} trigger={trigger}>
      {(close) => (
        <Loader load={() => api<AssignableUser[]>("/users/assignable")} value={users} setValue={setUsers}>
          {(list) => (
            <>
              <Row active={!state.assignedUserId} onClick={() => pick(null, close)}>
                <span className="text-dim" style={{ flex: 1 }}>Sin asignar</span>
                {!state.assignedUserId ? <Check size={14} style={{ color: "var(--acc-deep)" }} /> : null}
              </Row>
              <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
              {list.map((u) => (
                <Row key={u.userId} active={state.assignedUserId === u.userId} onClick={() => pick(u.userId, close)}>
                  <Avatar name={u.name} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                  {state.assignedUserId === u.userId ? <Check size={14} style={{ color: "var(--acc-deep)" }} /> : null}
                </Row>
              ))}
              {list.length === 0 ? <p className="text-dim" style={{ fontSize: 12, padding: "8px 10px", margin: 0 }}>No hay miembros disponibles.</p> : null}
            </>
          )}
        </Loader>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Chip: Etapa  → GET /inbox/counters (stages) → POST /conversations/:id/stage
// ---------------------------------------------------------------------------
function StageChip({ state, onChanged, onError, stacked }: ChipProps) {
  const [stages, setStages] = useState<StageOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const label = state.stage?.name ?? "—";

  async function pick(code: string, close: () => void) {
    close();
    if (busy || code === state.stage?.code) return;
    setBusy(true);
    onError(null);
    try {
      // El backend espera { statusCode } (no { code }).
      await api(`/conversations/${state.conversationId}/stage`, { method: "POST", body: JSON.stringify({ statusCode: code }) });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const trigger = (
    <button style={{ ...CHIP, opacity: busy ? 0.6 : 1, width: stacked ? "100%" : undefined, justifyContent: stacked ? "space-between" : undefined }} title="Etapa del ciclo de vida">
      <Dot color={state.stage?.color} />
      <span className="text-dim" style={{ flexShrink: 0 }}>Etapa:</span>
      <b style={chipLabelStyle()}>{label}</b>
      <ChevronDown size={13} className="text-dim" />
    </button>
  );

  return (
    <Popover label="Etapa" stacked={stacked} trigger={trigger}>
      {(close) => (
        <Loader load={() => api<{ stages: StageOption[] }>("/inbox/counters").then((r) => r.stages)} value={stages} setValue={setStages}>
          {(list) => (
            <>
              {list.map((s) => (
                <Row key={s.code} active={state.stage?.code === s.code} onClick={() => pick(s.code, close)}>
                  <Dot color={s.color} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  {state.stage?.code === s.code ? <Check size={14} style={{ color: "var(--acc-deep)" }} /> : null}
                </Row>
              ))}
              {list.length === 0 ? <p className="text-dim" style={{ fontSize: 12, padding: "8px 10px", margin: 0 }}>Aún no hay etapas configuradas.</p> : null}
            </>
          )}
        </Loader>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Chip: + Etiqueta  → GET /tags → POST /contacts/bulk { action:"tag_add", ids:[contactId], tagId }
// Crear nueva → POST /tags, luego asignar.
// ---------------------------------------------------------------------------
function TagsChip({ state, onChanged, onError, stacked }: ChipProps) {
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  // Nombres ya asignados al contacto (del /context); comparación case-insensitive.
  const assigned = new Set(state.tags.map((t) => t.toLowerCase()));

  async function assign(tag: TagRow) {
    if (busy || assigned.has(tag.name.toLowerCase())) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/contacts/bulk`, { method: "POST", body: JSON.stringify({ action: "tag_add", ids: [state.contactId], tagId: tag.id }) });
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createAndAssign(close: () => void) {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    onError(null);
    try {
      const created = await api<TagRow>(`/tags`, { method: "POST", body: JSON.stringify({ name }) });
      await api(`/contacts/bulk`, { method: "POST", body: JSON.stringify({ action: "tag_add", ids: [state.contactId], tagId: created.id }) });
      setNewName("");
      setTags(null); // fuerza recarga del catálogo la próxima apertura
      onChanged();
      close();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const count = state.tags.length;
  const trigger = (
    <button style={{ ...CHIP, opacity: busy ? 0.6 : 1, width: stacked ? "100%" : undefined, justifyContent: stacked ? "space-between" : undefined }} title="Etiquetas del contacto">
      <TagIcon size={14} className="text-dim" />
      <b style={chipLabelStyle()}>{count > 0 ? `Etiquetas · ${count}` : "+ Etiqueta"}</b>
      <ChevronDown size={13} className="text-dim" />
    </button>
  );

  return (
    <Popover label="Etiquetas" stacked={stacked} trigger={trigger}>
      {(close) => (
        <Loader load={() => api<TagRow[]>("/tags")} value={tags} setValue={setTags}>
          {(list) => (
            <>
              {state.tags.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 6px 8px" }}>
                  {state.tags.map((t) => (
                    <span key={t} style={{ fontSize: 11, borderRadius: 999, padding: "2px 8px", background: "var(--acc-dim)", color: "var(--acc-deep)" }}>{t}</span>
                  ))}
                </div>
              ) : null}
              {list.filter((t) => !assigned.has(t.name.toLowerCase())).map((t) => (
                <Row key={t.id} onClick={() => assign(t)}>
                  <Dot color={t.color} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                  <Plus size={14} className="text-dim" />
                </Row>
              ))}
              <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0 6px" }} />
              <div style={{ display: "flex", gap: 6, padding: "0 6px 4px" }}>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createAndAssign(close); } }}
                  placeholder="Crear etiqueta…"
                  maxLength={40}
                  style={{ flex: 1, minWidth: 0, padding: "8px 10px", minHeight: 40, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 13 }}
                />
                <button
                  onClick={() => void createAndAssign(close)}
                  disabled={!newName.trim() || busy}
                  className="btn-accent"
                  style={{ borderRadius: 10, minWidth: 40, minHeight: 40, display: "grid", placeItems: "center", padding: 0, opacity: !newName.trim() || busy ? 0.5 : 1 }}
                  aria-label="Crear y asignar etiqueta"
                >
                  <Plus size={16} />
                </button>
              </div>
            </>
          )}
        </Loader>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------
type ChipProps = { state: OpState; onChanged: () => void; onError: (m: string | null) => void; stacked: boolean };

/** Carga perezosa del contenido del popover: busca cuando `value` es null (primera apertura
 *  o tras invalidarlo, p. ej. al crear una etiqueta). */
function Loader<T>({ load, value, setValue, children }: { load: () => Promise<T>; value: T | null; setValue: (v: T) => void; children: (v: T) => React.ReactNode }) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (value !== null) return;
    let alive = true;
    setErr(null);
    load()
      .then((v) => { if (alive) setValue(v); })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  if (err) return <p style={{ color: "var(--danger)", fontSize: 12, padding: "8px 10px", margin: 0 }}>{err}</p>;
  if (value === null) return <p className="text-dim" style={{ fontSize: 12, padding: "8px 10px", margin: 0 }}>Cargando…</p>;
  return <>{children(value)}</>;
}

/** Avatar circular con inicial (paridad con la lista / TuBot inbox). */
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      title={name}
      style={{ width: size, height: size, flexShrink: 0, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: size * 0.45 }}
    >
      {initial}
    </span>
  );
}

/** Sheet inferior (móvil). */
function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 60, display: "flex", alignItems: "flex-end" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: "100%", borderRadius: "18px 18px 0 0", padding: 16, maxHeight: "80dvh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 className="display" style={{ fontSize: 18, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", minWidth: 44, minHeight: 44, display: "grid", placeItems: "center" }} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
