"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, CreditCard, ExternalLink, MessageCircle, Send, X } from "lucide-react";
import { api } from "@/lib/api";
import { COPILOT_ACTION_CSS, celebrar, renderMarkdown, resaltar, type AssistantAction } from "@/lib/copilot-actions";
import { ConviAvatar } from "@/components/ConviAvatar";
import {
  CONVI_NAME,
  INACTIVIDAD_MS,
  avisosProactivos,
  chipsSugeridos,
  debeAbrirseSolo,
  debeOfrecerAyuda,
  estadoDeConvi,
  saludoDeConvi,
  textoDeProgreso,
  type ConviCtx,
} from "@/lib/convi";

type Msg = { role: "user" | "assistant"; content: string; actions?: AssistantAction[] };
type Step = { key: string; label: string; href: string; done: boolean; blocking: boolean };
type Ctx = (ConviCtx & { canConfigure: boolean; steps: Step[] }) | null;

const SUPPORT_WA = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;

/** Mismo corte que el armazón (globals.css): arriba riel a la izquierda, abajo pestañas. */
function esMovil(): boolean {
  try {
    return window.matchMedia("(max-width: 767px)").matches;
  } catch {
    return false;
  }
}
/** Una sola vez por sesión del navegador: un panel que se abre en cada navegación molesta. */
const ABIERTO_KEY = "cv_convi_abierto";
/** Si el dueño lo cerró, no vuelve a abrirse solo (queda el acceso con su progreso). */
const CERRADO_KEY = "cv_convi_cerrado";

/**
 * COP 2 — **Convi**: el copiloto como protagonista del montaje, no una burbuja olvidada.
 *
 * Qué cambia respecto del globo flotante anterior:
 *  - Tiene CARA (`ConviAvatar`) con estados, y nombre.
 *  - En MODO MONTAJE se abre solo la primera vez de la sesión, como panel acoplado a la
 *    derecha en escritorio y hoja inferior en móvil, saluda por el nombre del negocio y
 *    muestra la BARRA DE PROGRESO con los pasos clicables.
 *  - Si el dueño lo cierra, el acceso que queda lleva el avatar con su anillo de progreso
 *    (no un ícono genérico), y Convi vuelve a ofrecer ayuda si la pantalla queda quieta más
 *    de un minuto en un paso pendiente: ese es el momento exacto en que se abandona un
 *    montaje.
 *  - En MODO ASISTENCIA (100%) es un acceso discreto que AVISA de lo importante —saldo
 *    bajo, canal caído, citas por confirmar— en vez de esperar la pregunta.
 *
 * Accesible: el panel es un `dialog` con foco, se cierra con Escape, los mensajes van con
 * `aria-live`, y todas las animaciones se apagan con `prefers-reduced-motion`.
 */
export function SupportWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx>(null);
  // Elegibilidad: null = aún no sabemos; true = esta cuenta es de Conversia (mostrar a Convi);
  // false = el asistente NO aplica a esta cuenta (p. ej. una cuenta de otra marca que entró por
  // error a conversia-web) → NO lo mostramos ni intentamos conversar. El 404/403 del gate
  // (`assertConversia`) jamás debe llegar al dueño como un "(Not Found)" crudo.
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [celebrando, setCelebrando] = useState(false);
  const [falloAlgo, setFalloAlgo] = useState(false);
  const [avisoVisto, setAvisoVisto] = useState<string | null>(null);
  /** Hoja inferior COMPACTA (solo móvil): Convi se presenta sin tapar el panel. */
  const [compacto, setCompacto] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const eligibleRef = useRef<boolean | null>(null);
  useEffect(() => { eligibleRef.current = eligible; }, [eligible]);

  const cargarContexto = useCallback(
    () =>
      api<NonNullable<Ctx>>("/assistant/context")
        .then((c) => {
          setEligible(true);
          setCtx(c);
          return c;
        })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          // 404/403 = el asistente no aplica a esta cuenta → ocultarlo.
          // Cualquier otro fallo (red, 5xx transitorio) lo deja: es una cuenta Conversia con
          // un bache momentáneo, no una cuenta inelegible.
          setEligible(status === 404 || status === 403 ? false : true);
          return null;
        }),
    [],
  );

  // Contexto al montar. De aquí sale el saludo, el progreso y los avisos proactivos.
  useEffect(() => {
    void cargarContexto().then((c) => {
      if (!c) return;
      let yaSeAbrio = false;
      let loCerro = false;
      try {
        yaSeAbrio = sessionStorage.getItem(ABIERTO_KEY) === "1";
        loCerro = sessionStorage.getItem(CERRADO_KEY) === "1";
      } catch {
        /* sin sessionStorage (ventana privada): se comporta como primera vez */
      }
      if (debeAbrirseSolo({ mode: c.mode, yaSeAbrioEnLaSesion: yaSeAbrio, loCerroElDueno: loCerro })) {
        // En escritorio el panel es ACOPLADO: aparece completo y el contenido se corre, así
        // que no tapa nada. En móvil no hay a dónde correrse, y una hoja a pantalla casi
        // completa en la primera entrada le esconde el panel justo cuando quiere verlo: ahí
        // Convi se presenta COMPACTO (saludo + progreso) y se expande cuando el dueño toca.
        abrir(c, esMovil() ? "compacto" : "completo");
      } else if (!yaSeAbrio && !loCerro) {
        setPulse(true);
      }
    });
  }, [cargarContexto]);

  /**
   * COP 1 — ejecuta las acciones del turno. Llegan ya validadas por el servidor, así que
   * acá solo se obedecen. Las que mueven la pantalla van primero (el servidor las ordena).
   *
   * El resaltado se REINTENTA una vez: cuando el copiloto navega y resalta en el mismo
   * turno, el elemento de la pantalla nueva todavía no está montado en el primer intento.
   */
  const ejecutarAcciones = useCallback(
    (actions: AssistantAction[]) => {
      for (const a of actions) {
        if (a.type === "navigate") {
          router.push(a.to);
        } else if (a.type === "highlight") {
          if (!resaltar(a.target, a.text)) window.setTimeout(() => resaltar(a.target, a.text), 700);
        } else if (a.type === "celebrate") {
          celebrar();
          setCelebrando(true);
          window.setTimeout(() => setCelebrando(false), 2200);
        } else if (a.type === "checklist_refresh") {
          void cargarContexto();
          // El checklist de /canales escucha este evento y se recarga sin recargar la página.
          window.dispatchEvent(new CustomEvent("conversia:checklist:refresh"));
        }
        // `button` no se "ejecuta": se dibuja en el chat y el clic es del dueño.
      }
    },
    [router, cargarContexto],
  );

  /** Clic del dueño en un botón que Convi ofreció. */
  const tocarBoton = useCallback(
    (a: Extract<AssistantAction, { type: "button" }>) => {
      if (a.kind === "pago") router.push("/cobros");
      else if (a.kind === "whatsapp") router.push("/canales");
      else if (a.kind === "interno" && a.payload) router.push(a.payload);
      else if (a.kind === "externo" && a.payload) window.open(a.payload, "_blank", "noopener,noreferrer");
    },
    [router],
  );

  const ask = useCallback(async (userText: string) => {
    const body = userText.trim();
    if (!body || busy) return;
    const history = msgs.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: body }]);
    setText("");
    setBusy(true);
    setFalloAlgo(false);
    try {
      const r = await api<{ reply: string; wrote?: boolean; qa?: { passed: boolean } | null; actions?: AssistantAction[] }>("/assistant/message", {
        method: "POST",
        body: JSON.stringify({ message: body, route: pathname, history }),
      });
      let reply = r.reply;
      if (r.wrote && r.qa) reply += r.qa.passed ? "\n\n(Probé tu asistente con los escenarios clave: todo en orden ✔)" : "\n\n(Hice el cambio; en la prueba quedó algo por revisar — te aviso si hace falta.)";
      const actions = r.actions ?? [];
      setMsgs((m) => [...m, { role: "assistant", content: reply, actions: actions.filter((a) => a.type === "button") }]);
      ejecutarAcciones(actions);
    } catch (e) {
      // NUNCA mostrar el error técnico crudo al dueño (jamás un "(Not Found)"). Mensaje humano
      // y accionable; si hay WhatsApp de soporte lo ofrecemos como salida.
      const status = (e as { status?: number }).status;
      // 401 = sesión vencida: lib/api ya limpió la sesión y está redirigiendo a /login. NO es un
      // fallo del asistente → no mostramos nada (evita el falso "No pude responder" del hallazgo 26-oct).
      if (status === 401) return;
      setFalloAlgo(true);
      const human =
        status === 429
          ? "Vamos un poco rápido 🙏. Espera unos segundos y escríbeme de nuevo."
          : status === 404 || status === 403
            ? "El asistente no está disponible en esta cuenta." + (SUPPORT_WA ? " Escríbele a soporte por WhatsApp y te ayudamos 💬." : " Escríbele a soporte y te ayudamos 💬.")
            : "No pude responder en este momento 🙏. Reintenta en unos segundos; si sigue, escríbele a soporte y lo vemos contigo.";
      setMsgs((m) => [...m, { role: "assistant", content: human }]);
    } finally {
      setBusy(false);
    }
  }, [busy, msgs, pathname, ejecutarAcciones]);

  /** Abre el panel y, la primera vez, deja el saludo de Convi. */
  const abrir = useCallback((contexto?: NonNullable<Ctx>, como: "completo" | "compacto" = "completo") => {
    const c = contexto ?? ctx;
    setOpen(true);
    setCompacto(como === "compacto");
    setPulse(false);
    try {
      sessionStorage.setItem(ABIERTO_KEY, "1");
    } catch {
      /* noop */
    }
    if (!seededRef.current && c) {
      seededRef.current = true;
      setMsgs((m) => (m.length ? m : [{ role: "assistant", content: saludoDeConvi(c) }]));
    }
  }, [ctx]);

  /** Cerrar es una decisión del dueño: Convi no vuelve a abrirse solo en esta sesión. */
  function cerrar() {
    setOpen(false);
    try {
      sessionStorage.setItem(CERRADO_KEY, "1");
    } catch {
      /* noop */
    }
  }

  // Bloque A y CTAs del checklist disparan este evento con el contexto ya cargado.
  useEffect(() => {
    function onOpen(e: Event) {
      // Handshake: si esta cuenta NO es elegible, no tomamos el evento → el disparador
      // (botón "Pedir ayuda") cae a su enlace de soporte. Con null (contexto aún cargando)
      // abrimos optimista: casi siempre es una cuenta Conversia.
      if (eligibleRef.current === false) return;
      e.preventDefault();
      const detail = (e as CustomEvent).detail as { topic?: string; context?: string } | undefined;
      abrir();
      if (detail?.context) setTimeout(() => void ask(`Necesito ayuda con esto: ${detail.context}`), 120);
    }
    window.addEventListener("conversia:assistant:open", onOpen as EventListener);
    return () => window.removeEventListener("conversia:assistant:open", onOpen as EventListener);
  }, [ask, abrir]);

  /**
   * MOMENTO CLAVE: la pantalla queda quieta en un paso PENDIENTE. El dueño abrió lo que le
   * tocaba y no hizo nada, que es justo cuando se abandona el montaje → Convi pulsa y
   * ofrece ayuda. Una sola vez por paso, para no volverse insistente.
   */
  const ofrecidoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ctx || ctx.mode !== "implementacion" || open) return;
    const paso = ctx.nextStep?.key ?? null;
    let quietoDesde = Date.now();
    const reactivar = () => { quietoDesde = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "scroll"] as const) window.addEventListener(ev, reactivar, { passive: true });
    const t = window.setInterval(() => {
      if (
        debeOfrecerAyuda({
          mode: ctx.mode,
          abierto: open,
          msQuieto: Date.now() - quietoDesde,
          pasoPendienteKey: paso,
          yaOfrecidoParaPaso: ofrecidoRef.current,
        })
      ) {
        ofrecidoRef.current = paso;
        setPulse(true);
      }
    }, 5_000);
    return () => {
      window.clearInterval(t);
      for (const ev of ["pointerdown", "keydown", "scroll"] as const) window.removeEventListener(ev, reactivar);
    };
  }, [ctx, open, pathname]);

  // Escape cierra el panel (accesibilidad: no obligar a encontrar la X con el mouse).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cerrar(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * ACOPLE: con el panel abierto en escritorio, el armazón corre el contenido a la derecha
   * (regla de `globals.css`) para que Convi no tape la pantalla que está explicando. Es un
   * panel lateral, no un globo encima. En móvil es hoja inferior y no hay acople.
   */
  useEffect(() => {
    const root = document.documentElement;
    // En compacto no se acopla nada: es una barra baja en móvil, donde no hay a dónde correr.
    if (open && !compacto) root.dataset.convi = "abierto";
    else delete root.dataset.convi;
    return () => { delete root.dataset.convi; };
  }, [open, compacto]);

  useEffect(() => { if (open) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 60); }, [open, msgs]);

  const waLink = SUPPORT_WA ? `https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent("Vengo del panel de Conversia y necesito ayuda")}` : null;

  // Cuenta inelegible (otra marca entró por error a conversia-web): no mostramos nada.
  // Así el dueño nunca ve el asistente que su cuenta no puede usar ni un error crudo del gate.
  if (eligible === false) return null;

  const montaje = ctx?.mode === "implementacion";
  const estado = estadoDeConvi({
    error: falloAlgo,
    celebrando,
    pensando: busy,
    conversacionEmpezada: msgs.length > 1,
  });
  const avisos = ctx && !montaje ? avisosProactivos(ctx) : [];
  const avisoPendiente = avisos.find((a) => a.key !== avisoVisto) ?? null;
  const pasosBloqueantes = (ctx?.steps ?? []).filter((s) => s.blocking);

  return (
    <>
      {!open ? (
        <button
          onClick={() => abrir()}
          aria-label={montaje ? `${CONVI_NAME}: ${textoDeProgreso(ctx!)}` : `${CONVI_NAME}, tu copiloto`}
          className={pulse ? "cv-convi-pulse" : ""}
          style={{ position: "fixed", right: 18, bottom: 78, zIndex: 40, width: 56, height: 56, borderRadius: "50%", background: "var(--card)", border: "1px solid var(--line)", boxShadow: "var(--shadow)", cursor: "pointer", display: "grid", placeItems: "center", padding: 0 }}
        >
          {/* El acceso lleva el avatar con su anillo de progreso, no un ícono genérico: el
              dueño ve de un vistazo cuánto le falta sin abrir nada. */}
          <ConviAvatar estado={pulse ? "saludando" : estado} size={48} progreso={montaje ? ctx?.checklistPct ?? 0 : null} />
          {avisoPendiente ? (
            <span aria-hidden="true" style={{ position: "absolute", top: 2, right: 2, width: 12, height: 12, borderRadius: "50%", background: avisoPendiente.urgente ? "var(--danger)" : "var(--acc-deep)", border: "2px solid var(--card)" }} />
          ) : null}
        </button>
      ) : compacto ? (
        /* COMPACTO (solo móvil, primera entrada): Convi se presenta y muestra el progreso
           SIN tapar el panel. El dueño ve su pantalla y a Convi a la vez, y lo expande
           cuando quiere hablar. Una hoja a pantalla casi completa en la primera entrada le
           esconde el panel justo cuando quiere verlo. */
        <div className="card cv-convi-peek" role="dialog" aria-label={`${CONVI_NAME}, tu copiloto`}>
          <ConviAvatar estado="saludando" size={40} progreso={montaje ? ctx?.checklistPct ?? 0 : null} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>
              {CONVI_NAME} te acompaña
            </p>
            <p className="text-dim" style={{ margin: 0, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ctx && montaje ? textoDeProgreso(ctx) : "¿En qué te ayudo?"}
            </p>
          </div>
          <button onClick={() => setCompacto(false)} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 12.5, padding: "7px 13px", whiteSpace: "nowrap" }}>
            {ctx?.nextStep ? "Empecemos" : "Abrir"}
          </button>
          <button onClick={cerrar} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", lineHeight: 0 }}><X size={16} /></button>
        </div>
      ) : (
        <div
          ref={panelRef}
          className="card cv-convi-panel"
          role="dialog"
          aria-label={`${CONVI_NAME}, tu copiloto`}
          aria-modal="false"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--hairline)" }}>
            <ConviAvatar estado={estado} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{CONVI_NAME}</p>
              <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>
                {ctx ? (montaje ? textoDeProgreso(ctx) : "Todo listo · te aviso lo importante") : "…"}
                {ctx?.saldo && !montaje ? ` · ${ctx.saldo}` : ""}
              </p>
            </div>
            <button onClick={cerrar} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }}><X size={18} /></button>
          </div>

          {/* BARRA DE PROGRESO del montaje, con los pasos clicables. Siempre visible mientras
              falte algo: es el mapa del camino, no un adorno. */}
          {montaje && pasosBloqueantes.length ? (
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--hairline)" }}>
              <div role="progressbar" aria-valuenow={ctx?.checklistPct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Avance del montaje"
                style={{ height: 6, borderRadius: 999, background: "var(--bg-tint)", overflow: "hidden", marginBottom: 9 }}>
                <div style={{ width: `${ctx?.checklistPct ?? 0}%`, height: "100%", background: "var(--acc)", transition: "width .4s ease" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {pasosBloqueantes.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => void ask(`Ayúdame con: ${s.label}`)}
                    style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", padding: "3px 0", textAlign: "left", color: s.done ? "var(--ink-dim)" : "var(--ink)", fontSize: 12.5 }}
                  >
                    <span style={{ width: 16, height: 16, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", background: s.done ? "var(--acc)" : "transparent", border: s.done ? "none" : "1.5px solid var(--line)", color: "var(--acc-ink)" }}>
                      {s.done ? <Check size={11} strokeWidth={3} /> : null}
                    </span>
                    <span style={{ textDecoration: s.done ? "line-through" : "none" }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* MODO ASISTENCIA: Convi avisa de lo importante sin que le pregunten. */}
          {avisoPendiente ? (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 14px", borderBottom: "1px solid var(--hairline)", background: avisoPendiente.urgente ? "color-mix(in srgb, var(--danger) 8%, transparent)" : "var(--acc-dim)" }}>
              <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.4 }}>{avisoPendiente.texto}</span>
              <button onClick={() => { setAvisoVisto(avisoPendiente.key); void ask(avisoPendiente.texto); }} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 12, padding: "5px 10px", whiteSpace: "nowrap" }}>Vamos</button>
              <button onClick={() => setAvisoVisto(avisoPendiente.key)} aria-label="Descartar aviso" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", lineHeight: 0, paddingTop: 2 }}><X size={14} /></button>
            </div>
          ) : null}

          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {msgs.length === 0 ? <p className="text-dim" style={{ fontSize: 13 }}>Escríbeme y te ayudo a dejar tu asistente andando o resuelvo tus dudas.</p> : null}
            {msgs.map((m, i) => {
              const mine = m.role === "user";
              return (
                <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  {/* COP 1 — el markdown se RENDERIZA (negritas, listas, enlaces internos).
                      Antes se aplanaba, y "te falta **conectar tu WhatsApp**" perdía justo
                      el énfasis que marca la acción. `aria-live` para los lectores. */}
                  <div
                    aria-live={mine ? undefined : "polite"}
                    style={{ padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.45, wordBreak: "break-word", background: mine ? "var(--acc)" : "var(--surface-solid)", color: mine ? "var(--acc-ink)" : "var(--ink)", border: mine ? "none" : "1px solid var(--hairline)" }}
                  >
                    {mine ? <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span> : renderMarkdown(m.content)}
                  </div>
                  {/* Botones del copiloto: pagar y conectar WhatsApp SOLO pasan por acá, con
                      el clic del dueño (el popup de Meta se bloquea si no nace de un clic). */}
                  {m.actions?.length ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      {m.actions.map((a, j) =>
                        a.type === "button" ? (
                          <button key={j} onClick={() => tocarBoton(a)} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 12.5, padding: "7px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {a.kind === "pago" ? <CreditCard size={14} /> : a.kind === "whatsapp" ? <MessageCircle size={14} /> : a.kind === "externo" ? <ExternalLink size={14} /> : null}
                            {a.label}
                          </button>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                  <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: mine ? "right" : "left" }}>{mine ? "Tú" : CONVI_NAME}</div>
                </div>
              );
            })}
            {busy ? <div className="text-dim" style={{ fontSize: 12, alignSelf: "flex-start" }}>{CONVI_NAME} está pensando…</div> : null}
            <div ref={bottomRef} />
          </div>

          {/* Chips DINÁMICOS: lo primero que ve el dueño es lo que le toca, no un menú fijo. */}
          {msgs.length <= 1 && !busy && ctx ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 8px" }}>
              {chipsSugeridos(ctx).map((s) => (
                <button key={s} onClick={() => void ask(s)} className="card" style={{ cursor: "pointer", fontSize: 12, padding: "6px 10px", borderRadius: 999 }}>{s}</button>
              ))}
            </div>
          ) : null}

          {waLink ? <a href={waLink} target="_blank" rel="noreferrer" className="text-accent" style={{ fontSize: 12, textAlign: "center", padding: "6px 0", textDecoration: "none", borderTop: "1px solid var(--hairline)" }}>Prefiero hablar por WhatsApp →</a> : null}

          <form onSubmit={(e) => { e.preventDefault(); void ask(text); }} style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--hairline)" }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Escríbele a ${CONVI_NAME}…`} aria-label={`Mensaje para ${CONVI_NAME}`} style={{ flex: 1, padding: "10px 12px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
            <button className="btn-accent" type="submit" disabled={busy || !text.trim()} style={{ borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", flexShrink: 0, opacity: busy || !text.trim() ? 0.5 : 1 }} aria-label="Enviar"><Send size={16} /></button>
          </form>
        </div>
      )}
      <style>{`
.cv-convi-pulse { animation: cvasst 1.8s ease-in-out 2; }
@keyframes cvasst { 0%,100% { box-shadow: var(--shadow); } 50% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--acc) 30%, transparent); } }
/* Panel ACOPLADO a la derecha en escritorio; HOJA INFERIOR en móvil. El breakpoint es EL
   MISMO que el del armazón (768px, globals.css): riel a la izquierda arriba de eso,
   pestañas abajo. Si se desalinean, en tablet el panel se solapa con la tab bar. */
.cv-convi-panel { position: fixed; z-index: 41; display: flex; flex-direction: column; padding: 0; overflow: hidden; }
@media (min-width: 768px) {
  .cv-convi-panel { right: 16px; top: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px)); }
}
@media (max-width: 767px) {
  .cv-convi-panel { left: 0; right: 0; bottom: 0; top: auto; height: min(78dvh, 640px); border-radius: 18px 18px 0 0; border-left: none; border-right: none; border-bottom: none; }
  .cv-convi-panel { animation: cvsheet .22s ease-out; }
}
@keyframes cvsheet { from { transform: translateY(16px); opacity: .7; } to { transform: translateY(0); opacity: 1; } }
/* COMPACTO: barra baja, por encima de la tab bar y de su safe-area. No tapa el panel. */
.cv-convi-peek {
  position: fixed; z-index: 41; left: 10px; right: 10px;
  bottom: calc(70px + env(safe-area-inset-bottom, 0px));
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 15px;
  animation: cvsheet .22s ease-out;
}
@media (prefers-reduced-motion: reduce) { .cv-convi-panel, .cv-convi-peek, .cv-convi-pulse { animation: none !important; } }
${COPILOT_ACTION_CSS}`}</style>
    </>
  );
}
