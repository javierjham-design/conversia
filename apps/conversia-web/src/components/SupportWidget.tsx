"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Send, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";

type Msg = { role: "user" | "assistant"; content: string };
type Ctx = { mode: "implementacion" | "asistencia"; checklistPct: number; nextStep: { label: string } | null; saldo: string | null; canConfigure: boolean } | null;

const SUPPORT_WA = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP;

/**
 * BLOQUE B — "Asistente Conversia" (evoluciona el F7): un solo chat que LIDERA la
 * implementación (mientras el checklist < 100%) y da asistencia general (al 100%).
 * Recibe el contexto del cliente server-side (checklist, saldo, pantalla). Escucha el
 * evento `conversia:assistant:open` del Bloque A para abrirse con el error ya cargado.
 */
export function SupportWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx>(null);
  // Elegibilidad: null = aún no sabemos; true = esta cuenta es de Conversia (mostrar burbuja);
  // false = el asistente NO aplica a esta cuenta (p. ej. una cuenta de otra marca que entró por
  // error a conversia-web) → NO mostramos la burbuja ni intentamos conversar. El 404/403 del gate
  // (`assertConversia`) jamás debe llegar al dueño como un "(Not Found)" crudo.
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  // Espejo de `eligible` para leerlo dentro de listeners sin re-suscribir el efecto.
  const eligibleRef = useRef<boolean | null>(null);
  useEffect(() => { eligibleRef.current = eligible; }, [eligible]);

  // Contexto al montar (para el saludo líder + el pulso proactivo). Barato.
  useEffect(() => {
    api<NonNullable<Ctx>>("/assistant/context")
      .then((c) => {
        setEligible(true);
        setCtx(c);
        if (c.mode === "implementacion" && typeof sessionStorage !== "undefined" && !sessionStorage.getItem("cv_asst_nudged")) {
          setPulse(true);
          sessionStorage.setItem("cv_asst_nudged", "1");
        }
      })
      .catch((e) => {
        const status = (e as { status?: number }).status;
        // 404/403 = el asistente no aplica a esta cuenta → ocultar la burbuja.
        // Cualquier otro fallo (red, 5xx transitorio) deja la burbuja: es una cuenta Conversia
        // con un bache momentáneo, no una cuenta inelegible.
        setEligible(status === 404 || status === 403 ? false : true);
      });
  }, []);

  const ask = useCallback(async (userText: string) => {
    const body = userText.trim();
    if (!body || busy) return;
    const history = msgs.slice(-12);
    setMsgs((m) => [...m, { role: "user", content: body }]);
    setText("");
    setBusy(true);
    try {
      const r = await api<{ reply: string; wrote?: boolean; qa?: { passed: boolean } | null }>("/assistant/message", {
        method: "POST",
        body: JSON.stringify({ message: body, route: pathname, history }),
      });
      let reply = r.reply;
      if (r.wrote && r.qa) reply += r.qa.passed ? "\n\n(Probé tu asistente con los escenarios clave: todo en orden ✔)" : "\n\n(Hice el cambio; en la prueba quedó algo por revisar — te aviso si hace falta.)";
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
    } catch (e) {
      // NUNCA mostrar el error técnico crudo al dueño (jamás un "(Not Found)"). Mensaje humano
      // y accionable; si hay WhatsApp de soporte lo ofrecemos como salida.
      const status = (e as { status?: number }).status;
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
  }, [busy, msgs, pathname]);

  // Saludo líder la primera vez que se abre (según el modo).
  function openWidget() {
    setOpen(true);
    setPulse(false);
    if (!seededRef.current && msgs.length === 0 && ctx) {
      seededRef.current = true;
      const greet = ctx.mode === "implementacion" && ctx.nextStep
        ? `¡Hola! Soy tu asistente de Conversia. Vamos a dejar tu bot andando: te falta **${ctx.nextStep.label.toLowerCase()}**. ¿Lo hacemos ahora?`
        : "¡Hola! Soy tu asistente de Conversia. ¿En qué te ayudo? Puedo resolver dudas, revisar tu saldo o configurar cosas de tu asistente.";
      setMsgs([{ role: "assistant", content: greet }]);
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
      setOpen(true);
      setPulse(false);
      if (detail?.context) setTimeout(() => void ask(`Necesito ayuda con esto: ${detail.context}`), 120);
    }
    window.addEventListener("conversia:assistant:open", onOpen as EventListener);
    return () => window.removeEventListener("conversia:assistant:open", onOpen as EventListener);
  }, [ask]);

  useEffect(() => { if (open) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 60); }, [open, msgs]);

  const waLink = SUPPORT_WA ? `https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent("Vengo del panel de Conversia y necesito ayuda")}` : null;

  // Cuenta inelegible (otra marca entró por error a conversia-web): no mostramos la burbuja.
  // Así el dueño nunca ve el asistente que su cuenta no puede usar ni un error crudo del gate.
  if (eligible === false) return null;

  return (
    <>
      {!open ? (
        <button onClick={openWidget} aria-label="Asistente" className={pulse ? "cv-asst-pulse" : ""}
          style={{ position: "fixed", right: 18, bottom: 78, zIndex: 40, width: 54, height: 54, borderRadius: "50%", background: "var(--acc)", color: "var(--acc-ink)", border: "none", boxShadow: "var(--shadow)", cursor: "pointer", display: "grid", placeItems: "center" }}>
          <Sparkles size={24} />
        </button>
      ) : (
        <div className="card" style={{ position: "fixed", right: 16, bottom: 72, zIndex: 41, width: "min(370px, calc(100vw - 32px))", height: "min(540px, calc(100dvh - 120px))", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--hairline)" }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", flexShrink: 0 }}><Sparkles size={17} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Asistente Conversia</p>
              <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>
                {ctx ? (ctx.mode === "implementacion" ? `Implementación · ${ctx.checklistPct}% listo` : "Asistencia") : "…"}
                {ctx?.saldo ? ` · ${ctx.saldo}` : ""}
              </p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }}><X size={18} /></button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {msgs.length === 0 ? <p className="text-dim" style={{ fontSize: 13 }}>Escríbeme y te ayudo a dejar tu asistente andando o resuelvo tus dudas.</p> : null}
            {msgs.map((m, i) => {
              const mine = m.role === "user";
              return (
                <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "84%" }}>
                  <div style={{ padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", background: mine ? "var(--acc)" : "var(--surface-solid)", color: mine ? "var(--acc-ink)" : "var(--ink)", border: mine ? "none" : "1px solid var(--hairline)" }}>{m.content.replace(/\*\*(.+?)\*\*/g, "$1")}</div>
                  <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: mine ? "right" : "left" }}>{mine ? "Tú" : "Asistente"}</div>
                </div>
              );
            })}
            {busy ? <div className="text-dim" style={{ fontSize: 12, alignSelf: "flex-start" }}>escribiendo…</div> : null}
            <div ref={bottomRef} />
          </div>

          {/* Acciones sugeridas (al inicio de la conversación), según el modo. */}
          {msgs.length <= 1 && !busy ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 8px" }}>
              {(ctx?.mode === "implementacion"
                ? ["¿Qué me falta para activarlo?", "Ayúdame a conectar mi WhatsApp", "Cargar un servicio y su precio"]
                : ["¿Cuánto saldo me queda?", "Cambiar el precio de un servicio", "Hablar con una persona"]
              ).map((s) => (
                <button key={s} onClick={() => void ask(s)} className="card" style={{ cursor: "pointer", fontSize: 12, padding: "6px 10px", borderRadius: 999 }}>{s}</button>
              ))}
            </div>
          ) : null}

          {waLink ? <a href={waLink} target="_blank" rel="noreferrer" className="text-accent" style={{ fontSize: 12, textAlign: "center", padding: "6px 0", textDecoration: "none", borderTop: "1px solid var(--hairline)" }}>Prefiero hablar por WhatsApp →</a> : null}

          <form onSubmit={(e) => { e.preventDefault(); void ask(text); }} style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--hairline)" }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe aquí…" style={{ flex: 1, padding: "10px 12px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
            <button className="btn-accent" type="submit" disabled={busy || !text.trim()} style={{ borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", flexShrink: 0, opacity: busy || !text.trim() ? 0.5 : 1 }} aria-label="Enviar"><Send size={16} /></button>
          </form>
        </div>
      )}
      <style>{`.cv-asst-pulse { animation: cvasst 1.8s ease-in-out 2; } @keyframes cvasst { 0%,100% { box-shadow: var(--shadow); } 50% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--acc) 30%, transparent); } }`}</style>
    </>
  );
}
