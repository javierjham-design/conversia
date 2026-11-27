"use client";

/**
 * TikTok en Canales — lo que SÍ se puede hacer hoy, dicho sin adornos.
 *
 * «TikTok» son dos cosas distintas y conviene no mezclarlas:
 *
 *  1. **Los DM.** Para contestarlos con el asistente hace falta un permiso que TikTok
 *     entrega sólo después de verificar la cuenta de empresa y aprobar su revisión de
 *     seguridad y privacidad (DSPR). No es algo que podamos programar: es un trámite que
 *     TikTok resuelve. Por eso acá se dice así, en vez de poner un botón que no conecta.
 *  2. **Las ventas que nacen de TikTok.** Eso sí funciona hoy: cuando un flujo cierra una
 *     venta o un lead por WhatsApp, se lo devolvemos a TikTok para que sus anuncios dejen
 *     de repartir el presupuesto a ciegas. Esa es la conexión que esta tarjeta permite.
 *
 * El token NUNCA vuelve al navegador: el servidor lo guarda cifrado y acá sólo se ve el
 * identificador del origen de eventos. Detalle completo en docs/TIKTOK.md.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { COLOR_DE_RED, TikTokIcon } from "./brand-icons";

type EstadoTikTok = {
  status: string;
  eventSourceId: string | null;
  eventSource: string;
  hasTestEventCode: boolean;
  lastError: string | null;
} | null;

export function TarjetaTikTok() {
  const [estado, setEstado] = useState<EstadoTikTok>(null);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState(false);
  const [eventSourceId, setEventSourceId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [testEventCode, setTestEventCode] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [probando, setProbando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  async function cargar() {
    try {
      const r = await api<{ tiktok: EstadoTikTok }>("/integrations");
      setEstado(r.tiktok ?? null);
      setEventSourceId(r.tiktok?.eventSourceId ?? "");
    } catch {
      setEstado(null);
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, []);

  async function guardar() {
    setGuardando(true);
    setAviso(null);
    try {
      await api("/integrations/tiktok", {
        method: "POST",
        body: JSON.stringify({
          eventSourceId: eventSourceId.trim(),
          eventSource: "crm",
          ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
          ...(testEventCode.trim() ? { testEventCode: testEventCode.trim() } : {}),
        }),
      });
      setAccessToken("");
      setAbierto(false);
      await cargar();
      setAviso({ ok: true, texto: "Guardado. Ahora puedes probar la conexión." });
    } catch (e) {
      setAviso({ ok: false, texto: (e as Error).message });
    } finally {
      setGuardando(false);
    }
  }

  async function probar() {
    setProbando(true);
    setAviso(null);
    try {
      const r = await api<{ ok: boolean; detail?: string }>("/integrations/tiktok/test", { method: "POST", body: "{}" });
      setAviso({ ok: r.ok, texto: r.detail || (r.ok ? "TikTok recibió el evento." : "TikTok rechazó el evento.") });
      await cargar();
    } catch (e) {
      setAviso({ ok: false, texto: (e as Error).message });
    } finally {
      setProbando(false);
    }
  }

  async function desconectar() {
    if (!window.confirm("¿Desconectar TikTok? Dejaremos de enviarle tus ventas y sus anuncios volverán a optimizar a ciegas.")) return;
    setGuardando(true);
    try {
      await api("/integrations/tiktok", { method: "DELETE" });
      setAviso(null);
      await cargar();
    } finally {
      setGuardando(false);
    }
  }

  const conectado = Boolean(estado?.eventSourceId);
  const campo: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    borderRadius: 9,
    border: "1px solid var(--line)",
    background: "transparent",
    color: "inherit",
  };

  return (
    <div data-copilot="conectar-tiktok" className="card" style={{ padding: 18, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{ width: 40, height: 40, borderRadius: 12, background: COLOR_DE_RED.tiktok, color: "#fff", display: "grid", placeItems: "center", flexShrink: 0 }}
        >
          <TikTokIcon size={21} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>
            TikTok
            {conectado ? (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "var(--ok-dim, var(--acc-dim))", color: "var(--ok)" }}>
                Conectado
              </span>
            ) : null}
          </p>
          <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12.5, lineHeight: 1.45 }}>
            Si vendes por TikTok, avísale cuáles de sus videos terminan en venta: tus anuncios dejan de repartir el
            presupuesto hacia los que sólo juntan clics.
          </p>
        </div>
        {cargando ? (
          <Loader2 size={16} className="lp-spin" style={{ color: "var(--ink-dim)" }} />
        ) : conectado ? (
          <button
            onClick={() => void probar()}
            disabled={probando}
            className="btn-accent"
            style={{ border: "none", cursor: "pointer", fontSize: 12.5, padding: "7px 13px", whiteSpace: "nowrap" }}
          >
            {probando ? "Probando…" : "Probar conexión"}
          </button>
        ) : (
          <button
            onClick={() => setAbierto(!abierto)}
            data-accion="conectar-tiktok"
            className="btn-accent"
            style={{ border: "none", cursor: "pointer", fontSize: 12.5, padding: "7px 13px", whiteSpace: "nowrap" }}
          >
            {abierto ? "Cancelar" : "Conectar TikTok"}
          </button>
        )}
      </div>

      {/* Los DM: lo que NO depende de nosotros. Se dice siempre, conectado o no, porque es
          justo lo que el dueño viene a buscar cuando ve «TikTok» en Canales. */}
      <p className="text-dim" style={{ margin: "11px 0 0", fontSize: 12, lineHeight: 1.5, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <strong>Los mensajes directos de TikTok todavía no se pueden atender desde acá.</strong> TikTok entrega ese
        permiso sólo a cuentas de empresa verificadas y después de su propia revisión de seguridad; no es algo que
        podamos activar nosotros. Mientras tanto, lo que sí funciona —y es como vende la mayoría— es el enlace de tu
        biografía hacia WhatsApp: ahí tu asistente atiende igual que siempre.
      </p>

      {abierto && !conectado ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
          <p className="text-dim" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            Los dos datos salen de <strong>TikTok Events Manager</strong> → tu conjunto de eventos →{" "}
            <em>Configurar API de eventos</em>.
          </p>
          <label style={{ fontSize: 12.5 }}>
            Identificador del origen de eventos
            <input value={eventSourceId} onChange={(e) => setEventSourceId(e.target.value)} placeholder="C1A2B3D4E5F6" style={{ ...campo, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12.5 }}>
            Access Token
            <input
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Se guarda cifrado; no vuelve a mostrarse"
              style={{ ...campo, marginTop: 4 }}
            />
          </label>
          <label style={{ fontSize: 12.5 }}>
            Código de prueba <span className="text-dim">(opcional, recomendado)</span>
            <input value={testEventCode} onChange={(e) => setTestEventCode(e.target.value)} placeholder="TEST12345" style={{ ...campo, marginTop: 4 }} />
            <span className="text-dim" style={{ display: "block", marginTop: 4, fontSize: 11.5, lineHeight: 1.45 }}>
              Sin este código, el evento del botón <em>Probar</em> entra como una venta <strong>real</strong> en tus
              estadísticas de TikTok. Con él, TikTok lo deja aparte.
            </span>
          </label>
          <div>
            <button
              onClick={() => void guardar()}
              disabled={guardando || eventSourceId.trim().length < 6 || accessToken.trim().length < 10}
              className="btn-accent"
              style={{ border: "none", cursor: "pointer", fontSize: 13, padding: "8px 15px", opacity: guardando ? 0.6 : 1 }}
            >
              {guardando ? "Guardando…" : "Guardar y conectar"}
            </button>
          </div>
        </div>
      ) : null}

      {conectado ? (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12.5 }}>
          <span className="text-dim">
            Origen de eventos <strong>{estado?.eventSourceId}</strong>
            {estado?.hasTestEventCode ? " · con código de prueba" : " · sin código de prueba (lo que mandes cuenta como real)"}
          </span>
          <button onClick={() => void desconectar()} disabled={guardando} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--ink-dim)", textDecoration: "underline" }}>
            Desconectar
          </button>
        </div>
      ) : null}

      {estado?.lastError ? (
        <p style={{ margin: "9px 0 0", fontSize: 12.5, color: "var(--warn)", display: "flex", alignItems: "center", gap: 6 }}>
          <AlertTriangle size={14} /> {estado.lastError}
        </p>
      ) : null}

      {aviso ? (
        <p style={{ margin: "9px 0 0", fontSize: 12.5, color: aviso.ok ? "var(--ok)" : "var(--warn)", display: "flex", alignItems: "center", gap: 6 }}>
          {aviso.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {aviso.texto}
        </p>
      ) : null}
    </div>
  );
}
