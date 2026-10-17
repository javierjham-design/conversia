"use client";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Camera, Check, CheckCircle2, HelpCircle, Loader2, MessageCircle, MessageSquare, QrCode, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

/* BLOQUE A — Conexión de WhatsApp AUTOSERVICIO desde el panel del cliente (Embedded
 * Signup de Meta). Reusa el backend existente: GET /public/meta-config (config del SDK
 * por marca), POST /channels/embedded-signup (intercambio de code + alta), GET /channels
 * (lista), GET /onboarding (checklist). Errores legibles + reporte a la cola de operación. */

type Channel = { id: string; type: string; name: string; status: string; displayPhone: string | null; defaultAgentName: string | null };
type EsConfig = { appId: string; configId: string; graphVersion: string; featureType?: string; ready: boolean; mode?: string };
type ConnMode = "coexistence" | "embedded";

/** Pasos que corre el backend al conectar (se animan mientras el POST está en vuelo). */
const STEPS = ["Conectando con Meta…", "Registrando tu número…", "Compartiendo la línea de crédito…", "Creando tus plantillas…"];
/** En coexistencia NO se registra el número (ya está activo en la app) ni hay línea de crédito. */
const COEX_STEPS = ["Conectando con Meta…", "Vinculando el número que ya usas…", "Activando tu asistente…"];

/** Abre el Asistente Conversia (Bloque B) con el contexto ya cargado. Si aún no está
 * montado el listener, es un no-op inofensivo. */
function pedirAyuda(context: string, topic = "canal") {
  try { window.dispatchEvent(new CustomEvent("conversia:assistant:open", { detail: { topic, context } })); } catch { /* noop */ }
}

/** Traduce el fallo técnico a un mensaje ACCIONABLE (qué pasó + qué hacer). */
function mapConnectError(raw: string): { title: string; help: string } {
  const s = (raw || "").toLowerCase();
  if (/popup|bloque|blocked|ventana/.test(s)) return { title: "Tu navegador bloqueó la ventana de Meta", help: "Permite las ventanas emergentes para este sitio (o desactiva el bloqueador) y vuelve a intentarlo. La conexión abre una ventana de Facebook." };
  if (/dominio|domain|url.*(block|allow)|not allowed|sdk/.test(s)) return { title: "El dominio aún no está autorizado en Meta", help: "Falta habilitar este sitio en la app de Meta (dominios del SDK). Es un ajuste de configuración; pide ayuda al asistente y el equipo lo deja listo." };
  if (/verif|elegib|not eligible|unverified|no verificad/.test(s)) return { title: "Meta necesita verificar tu negocio", help: "Es un trámite único de Meta para confirmar que tu negocio existe. Te acompañamos a dejarlo listo hoy; o conecta el WhatsApp que ya usas, que normalmente no lo requiere." };
  if (/business|portfolio|página|page|no.*cuenta/.test(s)) return { title: "Falta tu cuenta de Meta Business o una página de Facebook", help: "Para WhatsApp Business necesitas una cuenta de Meta Business y una página de Facebook. Créalas en business.facebook.com y reintenta." };
  if (/already|en uso|in use|otra app|registered elsewhere/.test(s)) return { title: "Ese número ya está en uso en la app de WhatsApp", help: 'Si quieres SEGUIR usándolo en tu teléfono, usa "Conecta el WhatsApp que ya usas" (coexistencia): mantienes la app y tus chats. O usa un número nuevo dedicado.' };
  if (/133005|pin/.test(s)) return { title: "Tu número ya tenía un PIN de verificación", help: "Lo detectamos automáticamente. Si persiste, desactiva la verificación en dos pasos del número en WhatsApp Business y reintenta." };
  if (/cancel|denied|permiso|permission/.test(s)) return { title: "Se canceló o no se autorizó la conexión", help: "En la ventana de Meta hay que aceptar los permisos y elegir tu WhatsApp Business. Vuelve a intentarlo y completa todos los pasos." };
  if (/no devolvió|account|cuenta\/número|number/.test(s)) return { title: "Meta no devolvió la cuenta o el número", help: 'Reintenta y en la ventana elige "Editar configuración" para seleccionar tu WhatsApp Business (no "Reconectar").' };
  return { title: "No se pudo conectar", help: raw || "Ocurrió un error inesperado. Reintenta; si sigue, pide ayuda al asistente y el equipo lo revisa." };
}

export default function Canales() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [es, setEs] = useState<EsConfig | null>(null);
  const [coex, setCoex] = useState<EsConfig | null>(null);
  const [fbReady, setFbReady] = useState(false);
  const [whatsappDone, setWhatsappDone] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "error">("idle");
  const [stepIdx, setStepIdx] = useState(0);
  const [err, setErr] = useState<{ title: string; help: string } | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [needsVerif, setNeedsVerif] = useState(false);
  const sessionRef = useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string }>({});
  const modeRef = useRef<ConnMode>("coexistence");
  const attemptsRef = useRef(0);

  async function load() {
    const [chs, onb] = await Promise.all([
      api<Channel[]>("/channels").catch(() => [] as Channel[]),
      api<{ steps: { key: string; done: boolean }[] }>("/onboarding").catch(() => ({ steps: [] })),
    ]);
    setChannels(chs);
    setWhatsappDone(onb.steps.find((s) => s.key === "whatsapp")?.done ?? chs.some((c) => c.type === "WHATSAPP_CLOUD" && c.status === "active"));
  }
  useEffect(() => { void load(); }, []);

  // Config del SDK por marca (sin hardcodear nada en el build) + listener del popup.
  // Dos configs: coexistencia (recomendado) y número dedicado (Embedded Signup normal).
  useEffect(() => {
    api<EsConfig>("/public/meta-config?brand=conversia&mode=coexistence").then(setCoex).catch(() => undefined);
    api<EsConfig>("/public/meta-config?brand=conversia").then(setEs).catch(() => undefined);
    function onMsg(event: MessageEvent) {
      if (typeof event.origin !== "string" || !event.origin.endsWith("facebook.com")) return;
      let d: any = event.data;
      if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
      if (d?.type && d.type !== "WA_EMBEDDED_SIGNUP") return;
      const data = d?.data ?? d;
      if (data?.waba_id) sessionRef.current.wabaId = data.waba_id;
      if (data?.phone_number_id) sessionRef.current.phoneNumberId = data.phone_number_id;
      if (data?.business_id) sessionRef.current.businessId = data.business_id;
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Carga el SDK de Facebook apenas haya config (para que FB.login sea SÍNCRONO en el click).
  // Ambas vías comparten appId + versión (misma app de Meta); inicializa con la que esté lista.
  useEffect(() => {
    const cfg = coex?.ready ? coex : es?.ready ? es : null;
    if (!cfg) return;
    const w = window as any;
    if (w.FB) { setFbReady(true); return; }
    w.fbAsyncInit = () => { w.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: true, version: cfg.graphVersion }); setFbReady(true); };
    const sc = document.createElement("script");
    sc.async = true; sc.defer = true; sc.crossOrigin = "anonymous";
    sc.src = "https://connect.facebook.net/en_US/sdk.js";
    document.body.appendChild(sc);
  }, [es, coex]);

  async function reportFailure(detail: string) {
    // La vía coexistencia levanta su propia excepción en el backend; aquí solo reportamos
    // la vía de número dedicado (el backend de coexistencia ya deja constancia).
    if (attemptsRef.current < 2 || modeRef.current === "coexistence") return;
    // PELDAÑO 2: el backend clasifica si el fallo es por VERIFICACIÓN DE NEGOCIO de Meta
    // (excepción de mayor toque; operación acompaña hoy) y nos lo devuelve para explicarlo.
    const r = await api<{ needsVerification?: boolean }>("/channels/connect-report", {
      method: "POST",
      body: JSON.stringify({ detail, attempts: attemptsRef.current }),
    }).catch(() => null);
    if (r?.needsVerification) setNeedsVerif(true);
  }

  function fail(raw: string) {
    attemptsRef.current += 1;
    setPhase("error");
    // Detección temprana en cliente (antes de que vuelva el reporte) para el copy correcto.
    if (/verif|elegib|not eligible|unverified/i.test(raw)) setNeedsVerif(true);
    setErr(mapConnectError(raw));
    void reportFailure(raw);
  }

  async function finish(code: string) {
    if (!sessionRef.current.wabaId || !sessionRef.current.phoneNumberId) { fail("Meta no devolvió la cuenta/número."); return; }
    const coexistence = modeRef.current === "coexistence";
    const endpoint = coexistence ? "/channels/coexistence" : "/channels/embedded-signup";
    setPhase("connecting"); setStepIdx(0); setErr(null); setOkMsg(null);
    const steps = coexistence ? COEX_STEPS : STEPS;
    const timer = setInterval(() => setStepIdx((i) => Math.min(i + 1, steps.length - 1)), 1600);
    try {
      const r = await api<{ displayPhone: string; businessName?: string | null; coexistence?: boolean }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ code, wabaId: sessionRef.current.wabaId, phoneNumberId: sessionRef.current.phoneNumberId, businessId: sessionRef.current.businessId }),
      });
      clearInterval(timer);
      attemptsRef.current = 0;
      setPhase("idle");
      setOkMsg(
        coexistence
          ? `¡Listo! Conectamos el WhatsApp que ya usas: ${r.displayPhone}. Sigues respondiendo desde tu teléfono y tu asistente también.`
          : `¡Listo! WhatsApp conectado: ${r.displayPhone}${r.businessName ? ` · ${r.businessName}` : ""}.`,
      );
      await load();
    } catch (e) {
      clearInterval(timer);
      fail((e as Error).message);
    }
  }

  function connect(mode: ConnMode = "coexistence") {
    setErr(null); setOkMsg(null); setNeedsVerif(false);
    modeRef.current = mode;
    const cfg = mode === "coexistence" ? coex : es;
    if (!cfg?.ready) { fail("La conexión aún no está configurada para esta marca en el servidor."); return; }
    const w = window as any;
    if (!fbReady || !w.FB) { fail("No se pudo cargar el SDK de Facebook (¿bloqueador?) o el dominio aún no está autorizado en Meta."); return; }
    sessionRef.current = {};
    w.FB.login(
      (response: any) => {
        const code = response?.authResponse?.code;
        if (!code) { fail("Se canceló la conexión."); return; }
        void finish(code);
      },
      { config_id: cfg.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: cfg.featureType ?? "", sessionInfoVersion: "3" } },
    );
  }

  const waChannels = (channels ?? []).filter((c) => c.type === "WHATSAPP_CLOUD");
  const waActive = waChannels.find((c) => c.status === "active");
  const activeSteps = modeRef.current === "coexistence" ? COEX_STEPS : STEPS;
  // Al menos una vía disponible habilita el botón principal.
  const canConnect = Boolean(coex?.ready || es?.ready);

  return (
    <AppShell>
      <main style={{ maxWidth: 680, margin: "0 auto", padding: "28px 20px 44px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Canales</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 22px" }}>Conecta dónde conversan tus clientes contigo.</p>

        {okMsg ? (
          <div className="card" style={{ padding: 14, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", borderColor: "var(--ok)" }}>
            <CheckCircle2 size={18} style={{ color: "var(--ok)", flexShrink: 0 }} />
            <span style={{ fontSize: 14 }}>{okMsg}</span>
          </div>
        ) : null}

        {/* ---------- WhatsApp ---------- */}
        <div className="card" style={{ padding: 20, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 44, height: 44, borderRadius: 13, background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", flexShrink: 0 }}><MessageCircle size={22} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>WhatsApp</p>
              <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 13 }}>
                {waActive ? <>Conectado · {waActive.displayPhone}{waActive.defaultAgentName ? ` · atiende ${waActive.defaultAgentName}` : ""}</> : "Tu asistente atiende por tu número de WhatsApp Business."}
              </p>
            </div>
            {waActive ? <span style={{ fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 999, background: "var(--acc-dim)", color: "var(--acc-deep)", display: "inline-flex", alignItems: "center", gap: 5 }}><Check size={13} /> Activo</span> : null}
          </div>

          {/* Estado: conectando (stepper animado) */}
          {phase === "connecting" ? (
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 9 }}>
              {activeSteps.map((label, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13.5, opacity: i > stepIdx ? 0.4 : 1 }}>
                  {i < stepIdx ? <Check size={16} style={{ color: "var(--ok)" }} /> : i === stepIdx ? <Loader2 size={16} className="lp-spin" style={{ color: "var(--acc-deep)" }} /> : <span style={{ width: 16, height: 16, borderRadius: "50%", border: "1.5px solid var(--line)" }} />}
                  <span style={{ color: i === stepIdx ? "var(--ink)" : "var(--ink-dim)" }}>{label}</span>
                </div>
              ))}
            </div>
          ) : null}

          {/* Estado: error accionable */}
          {phase === "error" && err ? (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 12, background: "color-mix(in srgb, var(--warn) 9%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)" }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><AlertTriangle size={16} style={{ color: "var(--warn)", flexShrink: 0 }} /> {err.title}</p>
              <p className="text-dim" style={{ margin: "7px 0 12px", fontSize: 13, lineHeight: 1.5 }}>{err.help}</p>
              {needsVerif ? (
                <div style={{ margin: "0 0 12px", padding: 12, borderRadius: 10, background: "var(--acc-dim)" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Meta pide verificar tu negocio</p>
                  <p className="text-dim" style={{ margin: "5px 0 0", fontSize: 12.5, lineHeight: 1.5 }}>
                    Es un trámite de Meta para confirmar que tu negocio existe (una sola vez). Nosotros te acompañamos hoy para dejarlo listo. Si solo quieres empezar ya, conectar el WhatsApp <strong>que ya usas</strong> normalmente no lo necesita.
                  </p>
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => connect(modeRef.current)} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}><RefreshCw size={14} /> Reintentar</button>
                {needsVerif ? (
                  <button onClick={() => connect("coexistence")} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}><QrCode size={14} /> Usar el que ya tengo</button>
                ) : null}
                <button onClick={() => pedirAyuda(needsVerif ? `Me piden verificación de negocio en Meta al conectar un número nuevo. Quiero que una persona me acompañe hoy. (${err.title})` : `Error al conectar WhatsApp: ${err.title}. ${err.help}`)} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}><HelpCircle size={14} /> {needsVerif ? "Que me acompañe una persona" : "Pedir ayuda al asistente"}</button>
              </div>
            </div>
          ) : null}

          {/* Acción primaria (si no está conectado y no estamos en medio de algo) */}
          {!waActive && phase === "idle" ? (
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Vía 1 (recomendada): COEXISTENCIA — conecta el número que YA usa */}
              <div style={{ padding: 15, borderRadius: 13, border: "1px solid var(--acc)", background: "var(--acc-dim)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <QrCode size={17} style={{ color: "var(--acc-deep)" }} />
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>Conecta el WhatsApp que ya usas</span>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: "var(--acc-deep)", color: "#fff" }}>Recomendado</span>
                </div>
                <p className="text-dim" style={{ margin: "0 0 11px", fontSize: 13, lineHeight: 1.5 }}>
                  Escanea o ingresa el código desde tu app y listo. Sigues respondiendo desde tu teléfono con tus chats de siempre, y tu asistente atiende en paralelo. <strong>No necesitas página web ni cuenta de Facebook.</strong>
                </p>
                <button onClick={() => connect("coexistence")} disabled={!canConnect} className="btn-accent" style={{ border: "none", cursor: canConnect ? "pointer" : "not-allowed", fontSize: 14, padding: "10px 18px", display: "inline-flex", alignItems: "center", gap: 8, opacity: canConnect ? 1 : 0.6 }}>
                  <QrCode size={16} /> Conectar mi número <ArrowRight size={15} />
                </button>
              </div>

              {/* Vía 2: número dedicado (Embedded Signup normal) */}
              <div style={{ padding: 15, borderRadius: 13, border: "1px solid var(--line)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <MessageCircle size={16} style={{ color: "var(--ink-dim)" }} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Prefiero un número nuevo dedicado</span>
                </div>
                <p className="text-dim" style={{ margin: "0 0 11px", fontSize: 12.5, lineHeight: 1.5 }}>
                  Te armamos un número aparte solo para el asistente, sin tocar el tuyo. Se abre una ventana de Meta.
                </p>
                <button onClick={() => connect("embedded")} disabled={es ? !es.ready : true} className="card" style={{ cursor: es?.ready ? "pointer" : "not-allowed", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6, opacity: es?.ready ? 1 : 0.6 }}>
                  <MessageCircle size={14} /> Usar un número nuevo
                </button>
              </div>

              {!canConnect ? (
                <p className="text-dim" style={{ margin: 0, fontSize: 12 }}>La conexión se habilita en breve; mientras, pide ayuda al asistente y el equipo la deja lista.</p>
              ) : null}
            </div>
          ) : null}

          {/* Reconectar / agregar otro si ya hay uno */}
          {waActive && phase === "idle" ? (
            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => connect("coexistence")} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}><QrCode size={14} /> Conectar el que ya uso</button>
              <button onClick={() => connect("embedded")} className="card" style={{ cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}><MessageCircle size={14} /> Conectar otro número</button>
            </div>
          ) : null}
        </div>

        {/* ---------- Próximamente: Instagram + Messenger ---------- */}
        {[
          { key: "ig", label: "Instagram", Icon: Camera, desc: "Responde los DM de tu Instagram con el mismo asistente." },
          { key: "msj", label: "Messenger", Icon: MessageSquare, desc: "Atiende tu página de Facebook desde la misma bandeja." },
        ].map(({ key, label, Icon, desc }) => (
          <div key={key} className="card" style={{ padding: 18, marginBottom: 12, display: "flex", alignItems: "center", gap: 12, opacity: 0.92 }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--line)", color: "var(--ink-dim)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{label}</p>
              <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12.5 }}>{desc}</p>
            </div>
            <button onClick={() => pedirAyuda(`Quiero conectar ${label}.`, key)} className="card" style={{ cursor: "pointer", fontSize: 12.5, padding: "6px 12px" }}>Próximamente</button>
          </div>
        ))}

        {/* ---------- Checklist: conectar número ---------- */}
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
          {whatsappDone ? <CheckCircle2 size={17} style={{ color: "var(--ok)" }} /> : <span style={{ width: 17, height: 17, borderRadius: "50%", border: "1.5px solid var(--line)" }} />}
          <span className="text-dim">{whatsappDone ? "Tu número está conectado — ¡listo para atender!" : "Paso pendiente: conecta tu número de WhatsApp."}</span>
        </div>

        <style>{`.lp-spin { animation: lpspin 1s linear infinite; } @keyframes lpspin { to { transform: rotate(360deg); } }`}</style>
      </main>
    </AppShell>
  );
}
