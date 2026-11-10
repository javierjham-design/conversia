"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AlertTriangle, Check, CheckCircle2, HelpCircle, Loader2, MessageCircle, MinusCircle, RefreshCw, Smartphone } from "lucide-react";
import { api } from "@/lib/api";
import { openAssistant } from "@/lib/assistant";

/**
 * A2 — REPORTE DE CONEXIÓN de un canal, con prueba en vivo.
 *
 * Por qué existe: recién conectado, el panel se veía igual que antes por tres caminos
 * distintos (coexistencia sin número publicado, canal sin asistente, canal en un estado que
 * no era `active`), y el dueño no tenía dónde leer en qué estado quedó su número. Ver la
 * reproducción en el PR de A1.
 *
 * Es un componente y no parte de la página porque la tanda C lo reutiliza tal cual para
 * Instagram y Messenger: lo único que cambia entre canales es cómo se prueba.
 */

export interface ChequeoDeCanal {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** No se pudo averiguar (Meta no respondió). Se pinta en gris: no es un fallo del cliente. */
  unknown?: boolean;
}

export interface ReporteDeCanal {
  channelId: string;
  channelType: string;
  channelName: string;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: "GREEN" | "YELLOW" | "RED" | null;
  mode: "coexistence" | "dedicated";
  coexVerified: boolean;
  pendingNumber: boolean;
  wabaId: string | null;
  channelStatus: string;
  tokenHealthy: boolean;
  accountAlert: { type: string; message: string | null; at: string } | null;
  webhookSubscribed: boolean | null;
  defaultAgent: { id: string; name: string } | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  checks: ChequeoDeCanal[];
}

type AgenteAsignable = { id: string; name: string };

/** Cada cuánto se relee mientras Meta publica el número. */
const MS_ACTIVANDOSE = 15_000;
/** Cada cuánto se relee durante la prueba, y cuánto se espera un mensaje. */
const MS_PRUEBA = 5_000;
const MS_ESPERA_MAX = 120_000;

const CALIDAD: Record<string, string> = { GREEN: "buena", YELLOW: "regular", RED: "baja" };

/** Estado visible del canal, con su color. Un canal "pendiente" NO es un canal roto. */
export function estadoVisible(r: ReporteDeCanal): { texto: string; color: string } {
  if (r.pendingNumber) return { texto: "Activándose", color: "var(--warn)" };
  if (r.channelStatus === "error" || !r.tokenHealthy) return { texto: "Conexión interrumpida", color: "var(--danger)" };
  if (r.channelStatus !== "active") return { texto: "Activándose", color: "var(--warn)" };
  return { texto: "Activo", color: "var(--ok)" };
}

/** Fecha corta en la hora de Chile (la del negocio), o "—". */
function cuando(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return "—";
  }
}

/** Número en formato wa.me (solo dígitos). */
function soloDigitos(tel: string | null): string {
  return (tel ?? "").replace(/\D/g, "");
}

const fila = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13, padding: "5px 0" } as const;

export function ReporteDeCanal({
  channelId,
  onCambio,
  titulo = "WhatsApp",
}: {
  channelId: string;
  /** Avisa a la página que algo cambió (asistente asignado, número publicado). */
  onCambio?: () => void;
  titulo?: string;
}) {
  const [r, setR] = useState<ReporteDeCanal | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const [asignando, setAsignando] = useState(false);
  const [agentes, setAgentes] = useState<AgenteAsignable[] | null>(null);
  /** Marca de la última actividad ANTES de empezar la prueba (para detectar lo nuevo). */
  const baseRef = useRef<{ inbound: string | null; outbound: string | null }>({ inbound: null, outbound: null });
  const finRef = useRef<number>(0);

  const leer = useCallback(
    async (fresh = false) => {
      try {
        const data = await api<ReporteDeCanal>(`/channels/${channelId}/status${fresh ? "?fresh=1" : ""}`);
        setR(data);
        setError(null);
        return data;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setCargando(false);
      }
    },
    [channelId],
  );

  useEffect(() => {
    void leer();
  }, [leer]);

  // Mientras Meta publica el número, la pantalla se refresca sola: era justo el caso en que
  // el dueño veía "Conectado ·" sin número y no sabía si tenía que hacer algo.
  useEffect(() => {
    if (!r?.pendingNumber || probando) return;
    const t = setInterval(() => {
      void leer(true).then((nuevo) => {
        if (nuevo && !nuevo.pendingNumber) onCambio?.();
      });
    }, MS_ACTIVANDOSE);
    return () => clearInterval(t);
  }, [r?.pendingNumber, probando, leer, onCambio]);

  // Prueba en vivo: se relee cada 5 s hasta que llegue el mensaje o se cumplan los 2 min.
  useEffect(() => {
    if (!probando) return;
    const t = setInterval(() => {
      if (Date.now() > finRef.current) {
        setProbando(false);
        return;
      }
      void leer(true).then((nuevo) => {
        // Llegó el mensaje Y la respuesta: la prueba cumplió, no tiene sentido seguir
        // girando (ni consultando a Meta) hasta que se cumplan los dos minutos.
        if (nuevo && nuevo.lastInboundAt !== baseRef.current.inbound && nuevo.lastOutboundAt !== baseRef.current.outbound) {
          setProbando(false);
        }
      });
    }, MS_PRUEBA);
    return () => clearInterval(t);
  }, [probando, leer]);

  async function probar() {
    const data = await leer(true);
    if (!data) return;
    baseRef.current = { inbound: data.lastInboundAt, outbound: data.lastOutboundAt };
    finRef.current = Date.now() + MS_ESPERA_MAX;
    setProbando(true);
  }

  async function asignar(agentId: string) {
    setAsignando(true);
    try {
      await api(`/channels/${channelId}`, { method: "PATCH", body: JSON.stringify({ defaultAgentId: agentId }) });
      await leer(true);
      onCambio?.();
      setAgentes(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsignando(false);
    }
  }

  async function abrirAsignar() {
    setAsignando(true);
    try {
      const lista = await api<AgenteAsignable[]>("/agents/assignable");
      // Con un solo asistente no hay nada que elegir: se asigna y listo.
      if (lista.length === 1) {
        await asignar(lista[0].id);
        return;
      }
      setAgentes(lista);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsignando(false);
    }
  }

  if (cargando) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <Loader2 size={18} className="lp-spin" style={{ color: "var(--acc-deep)" }} />
        <span className="text-dim" style={{ fontSize: 13.5 }}>Revisando tu conexión…</span>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 14 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>No pudimos leer el estado de tu canal</p>
        <p className="text-dim" style={{ margin: "6px 0 12px", fontSize: 13 }}>{error ?? "Reintenta en un momento."}</p>
        <button onClick={() => void leer(true)} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <RefreshCw size={14} /> Reintentar
        </button>
      </div>
    );
  }

  const est = estadoVisible(r);
  const nuevoEntrante = Boolean(r.lastInboundAt && r.lastInboundAt !== baseRef.current.inbound);
  const nuevoSaliente = Boolean(r.lastOutboundAt && r.lastOutboundAt !== baseRef.current.outbound);
  const segundos = nuevoEntrante && nuevoSaliente && r.lastInboundAt && r.lastOutboundAt
    ? Math.max(0, Math.round((new Date(r.lastOutboundAt).getTime() - new Date(r.lastInboundAt).getTime()) / 1000))
    : null;
  const fallos = r.checks.filter((c) => !c.ok && !c.unknown);
  const tel = soloDigitos(r.displayPhone);

  return (
    <div className="card" data-reporte-canal={r.channelId} style={{ padding: 20, marginBottom: 14 }}>
      {/* Encabezado: número, estado y quién atiende */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", flexShrink: 0 }}>
          <MessageCircle size={22} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>
            {titulo}
            {r.displayPhone ? <span style={{ fontWeight: 500 }}> · {r.displayPhone}</span> : null}
          </p>
          <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 13 }}>
            {r.pendingNumber
              ? "Activándose: Meta suele tardar unos minutos en publicar tu número."
              : r.defaultAgent
                ? `Atiende ${r.defaultAgent.name}`
                : "Falta asignar el asistente que atiende este número."}
          </p>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 999, background: `color-mix(in srgb, ${est.color} 14%, transparent)`, color: est.color, display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          {est.texto === "Activo" ? <Check size={13} /> : est.texto === "Activándose" ? <Loader2 size={13} className="lp-spin" /> : <AlertTriangle size={13} />}
          {est.texto}
        </span>
      </div>

      {/* Ficha: lo que el dueño quiere poder leer sin preguntarle a nadie */}
      <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <div style={fila}>
          <span className="text-dim">Nombre verificado</span>
          <span>{r.verifiedName ?? "—"}</span>
        </div>
        <div style={fila}>
          <span className="text-dim">Calidad del número</span>
          <span>{r.qualityRating ? CALIDAD[r.qualityRating] : "—"}</span>
        </div>
        <div style={fila}>
          <span className="text-dim">Modo</span>
          <span>{r.mode === "coexistence" ? "Tu número de siempre (coexistencia)" : "Número dedicado"}</span>
        </div>
        <div style={fila}>
          <span className="text-dim">Atiende</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {r.defaultAgent ? (
              r.defaultAgent.name
            ) : (
              <button onClick={() => void abrirAsignar()} disabled={asignando} data-accion="asignar-asistente" className="btn-accent" style={{ border: "none", cursor: asignando ? "wait" : "pointer", fontSize: 12.5, padding: "5px 11px" }}>
                {asignando ? "Asignando…" : "Asignar asistente"}
              </button>
            )}
          </span>
        </div>
        <div style={fila}>
          <span className="text-dim">Última actividad</span>
          <span>{r.lastInboundAt || r.lastOutboundAt ? `recibido ${cuando(r.lastInboundAt)} · respondido ${cuando(r.lastOutboundAt)}` : "sin mensajes todavía"}</span>
        </div>
      </div>

      {/* Selector de asistente (solo si hay más de uno) */}
      {agentes?.length ? (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 11, background: "var(--acc-dim)" }}>
          <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>¿Cuál atiende este número?</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {agentes.map((a) => (
              <button key={a.id} onClick={() => void asignar(a.id)} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "7px 12px" }}>
                {a.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Avisos de la cuenta: se cuentan con calma, nunca en tono de alarma */}
      {r.accountAlert ? (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 11, background: "color-mix(in srgb, var(--warn) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)" }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <b>Meta dejó un aviso en tu cuenta.</b> {r.accountAlert.message ?? r.accountAlert.type}
          </p>
          <button onClick={() => openAssistant({ topic: "canal", context: `Meta dejó este aviso en mi cuenta de WhatsApp: ${r.accountAlert?.message ?? r.accountAlert?.type}. ¿Qué significa y qué tengo que hacer?` })} className="card" style={{ marginTop: 8, cursor: "pointer", fontSize: 12.5, padding: "6px 11px" }}>
            Preguntar qué significa
          </button>
        </div>
      ) : null}

      {/* Acciones */}
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void probar()} disabled={probando} data-accion="probar-ahora" className="btn-accent" style={{ border: "none", cursor: probando ? "wait" : "pointer", fontSize: 13.5, padding: "9px 16px", display: "inline-flex", alignItems: "center", gap: 7, opacity: probando ? 0.7 : 1 }}>
          {probando ? <Loader2 size={15} className="lp-spin" /> : <Smartphone size={15} />} {probando ? "Esperando tu mensaje…" : "Probar ahora"}
        </button>
      </div>

      {/* Modo de prueba */}
      {probando || nuevoEntrante ? (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 12, border: "1px solid var(--line)" }}>
          {nuevoEntrante ? (
            <>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <CheckCircle2 size={16} style={{ color: "var(--ok)" }} />
                <span>Recibimos tu mensaje{nuevoSaliente ? <span style={{ fontWeight: 500 }}>{` y tu asistente respondió${segundos !== null ? ` en ${segundos} s` : ""}`}</span> : null}</span>
              </p>
              {!nuevoSaliente ? (
                <p className="text-dim" style={{ margin: "7px 0 0", fontSize: 13 }}>Esperando la respuesta de tu asistente…</p>
              ) : null}
            </>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Escríbele «hola» a tu número desde otro celular</p>
              <p className="text-dim" style={{ margin: "6px 0 10px", fontSize: 13, lineHeight: 1.5 }}>
                {r.displayPhone ? <>Tiene que ser desde un teléfono distinto al que tiene este número: {r.displayPhone}.</> : "En cuanto Meta publique tu número verás acá el enlace para probarlo."}
              </p>
              {tel ? (
                <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                  <a href={`https://wa.me/${tel}?text=hola`} target="_blank" rel="noopener noreferrer" className="card" style={{ fontSize: 13, padding: "8px 14px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <MessageCircle size={14} /> Abrir el chat
                  </a>
                  <span style={{ background: "#fff", padding: 7, borderRadius: 9, lineHeight: 0 }}>
                    <QRCodeSVG value={`https://wa.me/${tel}?text=hola`} size={86} />
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Diagnóstico: los chequeos. Solo se muestran si hay algo que decir. */}
      {(probando || fallos.length) && r.checks.length ? (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 7 }}>
          {r.checks.map((c) => (
            <div key={c.key} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
              {c.unknown ? (
                <MinusCircle size={15} style={{ color: "var(--ink-dim)", flexShrink: 0, marginTop: 1 }} />
              ) : c.ok ? (
                <CheckCircle2 size={15} style={{ color: "var(--ok)", flexShrink: 0, marginTop: 1 }} />
              ) : (
                <AlertTriangle size={15} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
              )}
              <span style={{ minWidth: 0 }}>
                <b style={{ fontWeight: 600 }}>{c.label}.</b> <span className="text-dim">{c.detail}</span>
                {c.fix && !c.ok && !c.unknown ? <span style={{ display: "block", marginTop: 2 }}>{c.fix}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Se cumplieron los 2 min sin mensaje: diagnóstico + una persona */}
      {!probando && finRef.current > 0 && !nuevoEntrante ? (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 11, background: "color-mix(in srgb, var(--warn) 9%, transparent)" }}>
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>No llegó ningún mensaje en dos minutos</p>
          <p className="text-dim" style={{ margin: "6px 0 10px", fontSize: 13, lineHeight: 1.5 }}>
            {fallos.length
              ? `Revisa lo que está pendiente arriba: ${fallos.map((f) => f.label.toLowerCase()).join("; ")}.`
              : "La conexión se ve bien de nuestro lado. Puede que el mensaje haya salido desde el mismo teléfono del número, que no cuenta."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void probar()} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <RefreshCw size={14} /> Probar de nuevo
            </button>
            <button
              onClick={() =>
                openAssistant({
                  topic: "canal",
                  context: `Probé mi WhatsApp desde Canales y no llegó el mensaje. Estado: ${est.texto}. Número: ${r.displayPhone ?? "sin publicar"}. Pendientes: ${fallos.map((f) => f.label).join("; ") || "ninguno"}.`,
                })
              }
              className="card"
              style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <HelpCircle size={14} /> Pedir ayuda al asistente
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
