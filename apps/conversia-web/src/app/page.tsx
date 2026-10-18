"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, CalendarCheck, Check, ChevronDown, CreditCard, Gift, Globe, Menu, MessageSquare,
  ShieldCheck, Sparkles, UserCheck, Users, Wand2, X, Zap,
} from "lucide-react";
import { api, getToken } from "@/lib/api";

/**
 * LANDING PÚBLICA de Conversia (apex conversia.cl). La ve quien NO ha iniciado sesión;
 * los usuarios con sesión activa se redirigen a su panel (/inicio). Diseño Nocturna
 * (tokens de globals.css). Gráficas 100% CSS/SVG — sin assets externos (evita CSP/peso).
 */

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

type Plan = { code: string; name: string; priceClp: number; features: Record<string, unknown> };
type Pack = { code: string; name: string; credits: number; priceClp: number };

export default function Landing() {
  const router = useRouter();
  const [base, setBase] = useState<Plan | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [menu, setMenu] = useState(false);
  const [faq, setFaq] = useState<number | null>(0);

  // La landing SIEMPRE se renderiza (SSR → SEO + primer paint). Si el visitante YA tiene
  // sesión, lo llevamos a su panel como efecto secundario (no bloquea el render del servidor).
  useEffect(() => {
    if (getToken()) router.replace("/inicio");
  }, [router]);

  // Precios reales del catálogo público V2 (si el go-live está encendido).
  useEffect(() => {
    api<Plan[]>("/public/plans?brand=conversia").then((p) => setBase(p.find((x) => x.code === "conversia_v2_base") ?? null)).catch(() => {});
    api<Pack[]>("/public/conversation-packs?brand=conversia").then(setPacks).catch(() => {});
  }, []);

  const basePrice = base ? clp(base.priceClp) : "$18.900";
  const baseIncluded = base ? (Number(base.features?.conversationsIncluded) || 100) : 100;

  return (
    <div className="lp">
      {/* ===================== NAV ===================== */}
      <header className="lp-nav">
        <a href="#top" className="lp-logo display">Conversia</a>
        <nav className="lp-links">
          <a href="#como">Cómo funciona</a>
          <a href="#funciones">Funciones</a>
          <a href="#precios">Precios</a>
          <a href="#faq">Preguntas</a>
        </nav>
        <div className="lp-nav-cta">
          <a href="/login" className="lp-ghost">Entrar</a>
          <a href="/crear" className="lp-btn">Crear gratis</a>
        </div>
        <button className="lp-burger" aria-label="Menú" onClick={() => setMenu((v) => !v)}>{menu ? <X size={22} /> : <Menu size={22} />}</button>
      </header>
      {menu ? (
        <div className="lp-mobile">
          <a href="#como" onClick={() => setMenu(false)}>Cómo funciona</a>
          <a href="#funciones" onClick={() => setMenu(false)}>Funciones</a>
          <a href="#precios" onClick={() => setMenu(false)}>Precios</a>
          <a href="#faq" onClick={() => setMenu(false)}>Preguntas</a>
          <a href="/login" onClick={() => setMenu(false)}>Entrar</a>
          <a href="/crear" className="lp-btn" onClick={() => setMenu(false)}>Crear mi asistente gratis</a>
        </div>
      ) : null}

      {/* ===================== HERO ===================== */}
      <section className="lp-hero" id="top">
        <div className="lp-blob lp-blob-1" aria-hidden />
        <div className="lp-blob lp-blob-2" aria-hidden />
        <div className="lp-hero-grid">
          <div className="lp-hero-copy lp-fade">
            <span className="lp-eyebrow"><Sparkles size={14} /> Atención por WhatsApp con IA</span>
            <h1 className="display">Tu negocio, atendido en WhatsApp <span className="display-italic lp-accent">las 24 horas</span>. Sin que muevas un dedo.</h1>
            <p className="lp-sub">Conversia responde, agenda y cotiza por ti con un asistente que <strong>se arma solo</strong> en minutos. Pruébalo con <strong>30 conversaciones gratis</strong>, sin tarjeta.</p>
            <div className="lp-hero-ctas">
              <a href="/crear" className="lp-btn lp-btn-lg">Crear mi asistente gratis <ArrowRight size={18} /></a>
              <a href="#como" className="lp-ghost lp-ghost-lg">Ver cómo funciona</a>
            </div>
            <ul className="lp-trust">
              <li><Check size={15} /> 30 conversaciones gratis</li>
              <li><Check size={15} /> Sin tarjeta</li>
              <li><Check size={15} /> Listo en minutos</li>
            </ul>
          </div>
          <div className="lp-hero-visual lp-fade lp-fade-2">
            <PhoneMock />
          </div>
        </div>
      </section>

      {/* ===================== TIRA DE VALOR ===================== */}
      <section className="lp-strip">
        {[
          { Icon: Zap, t: "Responde en segundos", d: "Nunca dejas a un cliente esperando." },
          { Icon: ShieldCheck, t: "No inventa precios", d: "Responde con tu info; si no sabe, deriva." },
          { Icon: UserCheck, t: "Sabe cuándo pasar a un humano", d: "Urgencias y casos sensibles a tu equipo." },
          { Icon: CalendarCheck, t: "Agenda y confirma solo", d: "Citas y recordatorios automáticos." },
        ].map(({ Icon, t, d }) => (
          <div key={t} className="lp-strip-item">
            <span className="lp-strip-ic"><Icon size={20} /></span>
            <div><p className="lp-strip-t">{t}</p><p className="lp-strip-d">{d}</p></div>
          </div>
        ))}
      </section>

      {/* ===================== CÓMO FUNCIONA ===================== */}
      <section className="lp-section" id="como">
        <SectionHead eyebrow="En 3 pasos" title={<>De cero a atendiendo, <span className="display-italic lp-accent">hoy mismo</span></>} sub="No necesitas saber de tecnología. Lo describes, lo pruebas y lo activas." />
        <div className="lp-steps">
          {[
            { n: 1, Icon: Wand2, t: "Descríbelo", d: "Dinos tu rubro y el nombre de tu negocio. Conversia lee tu web o Instagram y arma tu asistente con tus servicios." },
            { n: 2, Icon: MessageSquare, t: "Pruébalo", d: "Conversa con tu bot en un simulador, como lo haría un cliente. Ajusta el tono hasta que te guste." },
            { n: 3, Icon: Zap, t: "Actívalo", d: "Conéctalo a tu WhatsApp y empieza a atender solo. Tú supervisas desde una bandeja simple." },
          ].map(({ n, Icon, t, d }) => (
            <div key={n} className="lp-step card">
              <span className="lp-step-n">{n}</span>
              <span className="lp-step-ic"><Icon size={22} /></span>
              <h3 className="display">{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
        <div className="lp-center"><a href="/crear" className="lp-btn lp-btn-lg">Probar gratis ahora <ArrowRight size={18} /></a></div>
      </section>

      {/* ===================== FUNCIONES ===================== */}
      <section className="lp-section lp-section-alt" id="funciones">
        <SectionHead eyebrow="Todo en un solo lugar" title={<>Un equipo de atención <span className="display-italic lp-accent">que no duerme</span></>} sub="Conversia no es solo un chatbot: es la recepción completa de tu negocio." />
        <div className="lp-feats">
          {[
            { Icon: CalendarCheck, t: "Agenda automática", d: "Toma horas, confirma, reagenda y envía recordatorios sin que intervengas." },
            { Icon: MessageSquare, t: "Bandeja con copiloto", d: "Ves todas las conversaciones y, si quieres, apruebas las respuestas antes de enviarlas." },
            { Icon: ShieldCheck, t: "IA que no inventa", d: "Responde con tu información real. Ante dudas o urgencias, deriva a tu equipo." },
            { Icon: Globe, t: "Multicanal", d: "WhatsApp, Instagram y Messenger en una sola bandeja, con un solo asistente." },
            { Icon: CreditCard, t: "Cobra por WhatsApp", d: "Envía links de pago y cierra ventas sin salir del chat." },
            { Icon: Users, t: "Clientes ordenados", d: "Cada contacto con su historial, etiquetas y notas. Tu CRM, sin complicarte." },
          ].map(({ Icon, t, d }) => (
            <div key={t} className="lp-feat card">
              <span className="lp-feat-ic"><Icon size={22} /></span>
              <h3 className="display">{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===================== SE ARMA SOLO ===================== */}
      <section className="lp-section">
        <div className="lp-split">
          <div className="lp-split-copy lp-fade">
            <span className="lp-eyebrow"><Wand2 size={14} /> Se arma solo</span>
            <h2 className="display">Escribe el nombre de tu negocio y <span className="display-italic lp-accent">míralo cobrar vida</span></h2>
            <p className="lp-sub">Conversia lee tu sitio, entiende tu rubro y configura tu asistente con tus servicios y tono. En un minuto ya puedes conversar con él.</p>
            <ul className="lp-check">
              <li><Check size={16} /> Sin formularios eternos ni configuración técnica</li>
              <li><Check size={16} /> Plantillas por rubro (salud, retail, servicios y más)</li>
              <li><Check size={16} /> Lo pruebas antes de crear tu cuenta</li>
            </ul>
            <a href="/crear" className="lp-btn lp-btn-lg">Crear el mío <ArrowRight size={18} /></a>
          </div>
          <div className="lp-split-visual lp-fade lp-fade-2"><BuilderMock /></div>
        </div>
      </section>

      {/* ===================== PRECIOS ===================== */}
      <section className="lp-section lp-section-alt" id="precios">
        <SectionHead eyebrow="Precios simples" title={<>Pagas por <span className="display-italic lp-accent">conversación</span>, no por mensaje</>} sub="Una conversación es toda la atención a un cliente dentro de 24 horas — da igual cuántos mensajes se envíen." />
        <div className="lp-price-grid">
          <div className="lp-price card">
            <span className="lp-price-tag lp-price-tag-free"><Gift size={14} /> Para empezar</span>
            <h3 className="display">Gratis</h3>
            <p className="lp-price-amount display">30 <span>conversaciones</span></p>
            <p className="lp-price-note">Sin tarjeta. Pruébalo con clientes reales.</p>
            <ul className="lp-check">
              <li><Check size={15} /> Tu asistente completo</li>
              <li><Check size={15} /> Agenda y bandeja</li>
              <li><Check size={15} /> Conéctalo a tu WhatsApp</li>
            </ul>
            <a href="/crear" className="lp-ghost lp-ghost-lg lp-full">Empezar gratis</a>
          </div>

          <div className="lp-price card lp-price-feat">
            <span className="lp-price-tag"><Sparkles size={14} /> El más elegido</span>
            <h3 className="display">Base</h3>
            <p className="lp-price-amount display">{basePrice}<span>/mes</span></p>
            <p className="lp-price-note">{baseIncluded} conversaciones incluidas al mes.</p>
            <ul className="lp-check">
              <li><Check size={15} /> Todo lo de la prueba</li>
              <li><Check size={15} /> Multicanal (WhatsApp, IG, Messenger)</li>
              <li><Check size={15} /> Plantillas y cobros por WhatsApp</li>
              <li><Check size={15} /> El bot nunca queda mudo por saldo</li>
            </ul>
            <a href="/crear" className="lp-btn lp-full">Crear mi asistente</a>
          </div>

          <div className="lp-price card">
            <span className="lp-price-tag"><Zap size={14} /> Cuando creces</span>
            <h3 className="display">Packs</h3>
            <p className="lp-price-amount display">+ conversaciones</p>
            <p className="lp-price-note">Suma cuando lo necesites. No vencen pronto.</p>
            <ul className="lp-check">
              {(packs.length ? packs : [
                { code: "a", name: "Recarga 100", credits: 100, priceClp: 21900 },
                { code: "b", name: "Pack 400", credits: 400, priceClp: 84900 },
                { code: "c", name: "Pack 1.000", credits: 1000, priceClp: 199900 },
              ]).map((p) => (
                <li key={p.code}><Check size={15} /> {p.credits.toLocaleString("es-CL")} conversaciones · {clp(p.priceClp)}</li>
              ))}
            </ul>
            <a href="/crear" className="lp-ghost lp-ghost-lg lp-full">Empezar gratis</a>
          </div>
        </div>
        <p className="lp-center lp-fineprint">¿Tienes un equipo y prefieres que lo dejemos todo listo por ti? Escríbenos por el plan <strong>Gestionado</strong>.</p>
      </section>

      {/* ===================== FAQ ===================== */}
      <section className="lp-section" id="faq">
        <SectionHead eyebrow="Preguntas frecuentes" title={<>Lo que todos <span className="display-italic lp-accent">se preguntan</span></>} />
        <div className="lp-faq">
          {FAQS.map((f, i) => (
            <div key={i} className={faq === i ? "lp-faq-item open" : "lp-faq-item"}>
              <button onClick={() => setFaq(faq === i ? null : i)} aria-expanded={faq === i}>
                <span>{f.q}</span><ChevronDown size={18} />
              </button>
              <div className="lp-faq-a"><p>{f.a}</p></div>
            </div>
          ))}
        </div>
      </section>

      {/* ===================== CTA FINAL ===================== */}
      <section className="lp-cta">
        <div className="lp-cta-inner">
          <h2 className="display">Tu próximo cliente ya está escribiendo. <span className="display-italic">Que no espere.</span></h2>
          <p>Crea tu asistente en minutos y atiende por WhatsApp hoy mismo. 30 conversaciones gratis.</p>
          <a href="/crear" className="lp-btn lp-btn-lg lp-btn-invert">Crear mi asistente gratis <ArrowRight size={18} /></a>
        </div>
      </section>

      {/* ===================== FOOTER ===================== */}
      <footer className="lp-footer">
        <div className="lp-footer-grid">
          <div>
            <p className="lp-logo display">Conversia</p>
            <p className="lp-foot-tag">Atención por WhatsApp con inteligencia artificial para tu negocio.</p>
          </div>
          <div>
            <p className="lp-foot-h">Producto</p>
            <a href="/crear">Crear asistente</a>
            <a href="#funciones">Funciones</a>
            <a href="#precios">Precios</a>
            <a href="/login">Entrar</a>
          </div>
          <div>
            <p className="lp-foot-h">Legal</p>
            <a href="/legal/terminos">Términos</a>
            <a href="/legal/privacidad">Privacidad</a>
          </div>
          <div>
            <p className="lp-foot-h">Contacto</p>
            <a href="mailto:contacto@conversia.cl">contacto@conversia.cl</a>
          </div>
        </div>
        <div className="lp-foot-bottom">
          <span>© {new Date().getFullYear()} Conversia</span>
          <span>Hecho en Chile 🇨🇱</span>
        </div>
      </footer>

      <LandingStyles />
    </div>
  );
}

/* ---------------- Encabezado de sección ---------------- */
function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: React.ReactNode; sub?: string }) {
  return (
    <div className="lp-head">
      <span className="lp-eyebrow">{eyebrow}</span>
      <h2 className="display">{title}</h2>
      {sub ? <p className="lp-sub">{sub}</p> : null}
    </div>
  );
}

/* ---------------- Mockup de teléfono con chat WhatsApp ---------------- */
function PhoneMock() {
  return (
    <div className="lp-phone">
      <div className="lp-phone-notch" />
      <div className="lp-chat">
        <div className="lp-chat-top">
          <span className="lp-chat-av">DD</span>
          <div><p className="lp-chat-name">Clínica Dental</p><p className="lp-chat-on">en línea · responde al instante</p></div>
        </div>
        <div className="lp-chat-body">
          <div className="lp-bub lp-in">Hola, ¿tienen hora para limpieza esta semana? 😁</div>
          <div className="lp-bub lp-out">¡Hola! Sí 🙌 Tengo el jueves 15:00 o el viernes 10:30 con la Dra. Soto. ¿Cuál te acomoda?</div>
          <div className="lp-bub lp-in">El jueves 15:00</div>
          <div className="lp-bub lp-out">¡Listo! Agendé tu limpieza para el jueves a las 15:00. Te mando un recordatorio el día antes. ¿Algo más? ✨</div>
          <div className="lp-typing"><span /><span /><span /></div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Mockup del generador "se arma solo" ---------------- */
function BuilderMock() {
  return (
    <div className="lp-builder card">
      <div className="lp-builder-row"><span className="lp-builder-lb">Tu negocio</span><span className="lp-builder-val">Clínica Dental Sonríe</span></div>
      <div className="lp-builder-row"><span className="lp-builder-lb">Rubro</span><span className="lp-chip">Salud · Dental</span></div>
      <div className="lp-builder-steps">
        <p className="done"><Check size={14} /> Leyendo tu sitio web…</p>
        <p className="done"><Check size={14} /> Configurando tu asistente…</p>
        <p className="done"><Check size={14} /> Preparando tu agenda…</p>
        <p className="live"><span className="lp-dot" /> Tu asistente ya puede atender</p>
      </div>
      <a href="/crear" className="lp-btn lp-full">Probar conmigo</a>
    </div>
  );
}

const FAQS = [
  { q: "¿Qué cuenta como una “conversación”?", a: "Toda la atención a un mismo cliente dentro de una ventana de 24 horas, sin importar cuántos mensajes se intercambien. Es la forma más justa y predecible de cobrar." },
  { q: "¿Necesito tarjeta para probar?", a: "No. Creas tu asistente y tienes 30 conversaciones gratis para probarlo con clientes reales. Activas un plan solo cuando quieras seguir." },
  { q: "¿Funciona con mi número de WhatsApp actual?", a: "Conversia usa la plataforma oficial de WhatsApp Business. Te guiamos para conectar tu número y empezar a atender." },
  { q: "¿La IA puede equivocarse o inventar cosas?", a: "El asistente está diseñado para responder solo con tu información y para no inventar precios ni horarios. Ante dudas o urgencias, deriva a una persona de tu equipo." },
  { q: "¿Qué pasa cuando se acaban mis conversaciones?", a: "Tu bot nunca queda mudo: entra en modo copiloto (te sugiere respuestas para que apruebes) por unos días antes de pausar, y nada de tu información se borra." },
  { q: "¿Puedo cancelar cuando quiera?", a: "Sí. Cancelas desde el panel y tu cuenta sigue activa hasta el fin del período pagado. Sin ataduras." },
];

/* ---------------- Estilos de la landing (Nocturna + gráficas) ---------------- */
function LandingStyles() {
  return (
    <style>{`
.lp { --lp-max: 1120px; color: var(--ink); overflow-x: hidden; }
.lp a { color: inherit; }
.lp .display-italic { font-style: italic; }
.lp-accent { color: var(--acc-deep); }

/* NAV */
.lp-nav { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 20px; padding: 14px clamp(16px,4vw,40px); backdrop-filter: blur(12px); background: color-mix(in srgb, var(--surface-solid) 82%, transparent); border-bottom: 1px solid var(--hairline); }
.lp-logo { font-size: 22px; text-decoration: none; color: var(--ink); }
.lp-links { display: flex; gap: 22px; margin-left: 18px; }
.lp-links a { font-size: 14px; text-decoration: none; color: var(--ink-dim); }
.lp-links a:hover { color: var(--ink); }
.lp-nav-cta { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.lp-burger { display: none; margin-left: auto; background: none; border: none; color: var(--ink); cursor: pointer; }
.lp-mobile { position: sticky; top: 56px; z-index: 29; display: flex; flex-direction: column; gap: 4px; padding: 10px 16px 16px; background: var(--surface-solid); border-bottom: 1px solid var(--hairline); }
.lp-mobile a { padding: 10px; text-decoration: none; color: var(--ink); border-radius: 10px; }

/* Botones */
.lp-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--acc); color: var(--acc-ink); border: none; border-radius: 12px; padding: 10px 18px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: transform .15s, filter .15s; }
.lp-btn:hover { transform: translateY(-1px); filter: brightness(1.05); }
.lp-btn-lg { padding: 14px 24px; font-size: 15.5px; border-radius: 14px; }
.lp-btn-invert { background: var(--acc-ink); color: var(--acc-deep); }
.lp-ghost { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--ink); border: 1px solid var(--line); border-radius: 12px; padding: 10px 18px; font-size: 14px; font-weight: 600; background: transparent; }
.lp-ghost:hover { border-color: var(--acc); color: var(--acc-deep); }
.lp-ghost-lg { padding: 13px 22px; font-size: 15px; border-radius: 14px; }
.lp-full { width: 100%; justify-content: center; margin-top: auto; }

/* HERO */
.lp-hero { position: relative; padding: clamp(40px,7vw,90px) clamp(16px,4vw,40px) clamp(30px,5vw,60px); max-width: var(--lp-max); margin: 0 auto; }
.lp-hero-grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 40px; align-items: center; }
.lp-hero-copy h1 { font-size: clamp(32px,5.2vw,54px); line-height: 1.05; margin: 16px 0 0; font-weight: 600; letter-spacing: -0.5px; }
.lp-eyebrow { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; color: var(--acc-deep); background: var(--acc-dim); border-radius: 999px; padding: 6px 13px; }
.lp-sub { font-size: clamp(15px,1.6vw,18px); color: var(--ink-dim); line-height: 1.6; margin: 18px 0 0; max-width: 46ch; }
.lp-hero-ctas { display: flex; flex-wrap: wrap; gap: 12px; margin: 28px 0 0; }
.lp-trust { display: flex; flex-wrap: wrap; gap: 16px; list-style: none; padding: 0; margin: 22px 0 0; }
.lp-trust li { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-dim); }
.lp-trust svg { color: var(--ok); }
.lp-blob { position: absolute; border-radius: 50%; filter: blur(70px); opacity: .5; z-index: -1; pointer-events: none; }
.lp-blob-1 { width: 420px; height: 420px; background: radial-gradient(circle, var(--acc) 0%, transparent 70%); top: -80px; right: -60px; }
.lp-blob-2 { width: 360px; height: 360px; background: radial-gradient(circle, var(--acc-deep) 0%, transparent 70%); bottom: -120px; left: -80px; opacity: .3; }

/* Teléfono */
.lp-hero-visual { display: flex; justify-content: center; }
.lp-phone { position: relative; width: 300px; max-width: 86vw; background: var(--surface-solid); border: 1px solid var(--line); border-radius: 36px; padding: 14px 12px; box-shadow: 0 30px 70px -30px rgba(0,0,0,.45); }
.lp-phone-notch { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: 110px; height: 22px; background: var(--line); border-radius: 0 0 14px 14px; }
.lp-chat { border-radius: 24px; overflow: hidden; background: color-mix(in srgb, var(--acc) 7%, var(--surface-solid)); }
.lp-chat-top { display: flex; align-items: center; gap: 10px; padding: 26px 14px 12px; background: var(--acc-deep); color: var(--acc-ink); }
.lp-chat-av { width: 34px; height: 34px; border-radius: 50%; background: color-mix(in srgb, var(--acc-ink) 25%, transparent); display: grid; place-items: center; font-size: 12px; font-weight: 700; }
.lp-chat-name { margin: 0; font-size: 14px; font-weight: 700; }
.lp-chat-on { margin: 0; font-size: 11px; opacity: .85; }
.lp-chat-body { padding: 14px 12px 18px; display: flex; flex-direction: column; gap: 9px; min-height: 300px; }
.lp-bub { max-width: 82%; padding: 9px 12px; border-radius: 14px; font-size: 13px; line-height: 1.45; }
.lp-in { align-self: flex-start; background: var(--surface-solid); border: 1px solid var(--hairline); border-bottom-left-radius: 4px; }
.lp-out { align-self: flex-end; background: var(--acc); color: var(--acc-ink); border-bottom-right-radius: 4px; }
.lp-typing { align-self: flex-start; display: inline-flex; gap: 4px; padding: 10px 12px; background: var(--surface-solid); border: 1px solid var(--hairline); border-radius: 14px; }
.lp-typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-dim); opacity: .5; animation: lpblink 1.2s infinite; }
.lp-typing span:nth-child(2){ animation-delay: .2s } .lp-typing span:nth-child(3){ animation-delay: .4s }
@keyframes lpblink { 0%,60%,100%{ opacity:.25; transform: translateY(0) } 30%{ opacity:.9; transform: translateY(-2px) } }

/* Tira */
.lp-strip { max-width: var(--lp-max); margin: 10px auto 0; padding: 24px clamp(16px,4vw,40px); display: grid; grid-template-columns: repeat(4,1fr); gap: 18px; }
.lp-strip-item { display: flex; gap: 12px; align-items: flex-start; }
.lp-strip-ic { flex-shrink: 0; width: 40px; height: 40px; border-radius: 11px; background: var(--acc-dim); color: var(--acc-deep); display: grid; place-items: center; }
.lp-strip-t { margin: 0; font-size: 14px; font-weight: 600; }
.lp-strip-d { margin: 2px 0 0; font-size: 12.5px; color: var(--ink-dim); line-height: 1.4; }

/* Secciones */
.lp-section { max-width: var(--lp-max); margin: 0 auto; padding: clamp(50px,7vw,88px) clamp(16px,4vw,40px); }
.lp-section-alt { max-width: none; background: color-mix(in srgb, var(--acc) 4%, transparent); }
.lp-section-alt > * { max-width: var(--lp-max); margin-left: auto; margin-right: auto; }
.lp-head { text-align: center; max-width: 640px; margin: 0 auto 44px; }
.lp-head h2, .lp-split h2, .lp-cta h2 { font-size: clamp(26px,3.6vw,38px); margin: 12px 0 0; font-weight: 600; letter-spacing: -0.3px; }
.lp-head .lp-sub { margin: 14px auto 0; }
.lp-center { text-align: center; margin-top: 36px; display: flex; justify-content: center; }

/* Pasos */
.lp-steps { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; }
.lp-step { padding: 26px 22px; position: relative; }
.lp-step-n { position: absolute; top: 18px; right: 20px; font-size: 40px; font-weight: 700; color: var(--acc); opacity: .18; }
.lp-step-ic { width: 46px; height: 46px; border-radius: 13px; background: var(--acc-dim); color: var(--acc-deep); display: grid; place-items: center; }
.lp-step h3 { font-size: 18px; margin: 16px 0 6px; } .lp-step p { margin: 0; font-size: 14px; color: var(--ink-dim); line-height: 1.55; }

/* Funciones */
.lp-feats { display: grid; grid-template-columns: repeat(3,1fr); gap: 18px; }
.lp-feat { padding: 24px 22px; }
.lp-feat-ic { width: 46px; height: 46px; border-radius: 13px; background: var(--acc-dim); color: var(--acc-deep); display: grid; place-items: center; }
.lp-feat h3 { font-size: 17px; margin: 15px 0 6px; } .lp-feat p { margin: 0; font-size: 14px; color: var(--ink-dim); line-height: 1.55; }

/* Split "se arma solo" */
.lp-split { display: grid; grid-template-columns: 1fr 1fr; gap: 44px; align-items: center; }
.lp-check { list-style: none; padding: 0; margin: 20px 0; display: flex; flex-direction: column; gap: 10px; }
.lp-check li { display: flex; align-items: center; gap: 9px; font-size: 14.5px; color: var(--ink-dim); } .lp-check svg { color: var(--ok); flex-shrink: 0; }
.lp-builder { padding: 22px; }
.lp-builder-row { display: flex; justify-content: space-between; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--hairline); font-size: 14px; }
.lp-builder-lb { color: var(--ink-dim); } .lp-builder-val { font-weight: 600; }
.lp-chip { background: var(--acc-dim); color: var(--acc-deep); border-radius: 999px; padding: 4px 11px; font-size: 12.5px; font-weight: 600; }
.lp-builder-steps { margin: 16px 0; display: flex; flex-direction: column; gap: 9px; }
.lp-builder-steps p { margin: 0; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.lp-builder-steps .done { color: var(--ink-dim); } .lp-builder-steps .done svg { color: var(--ok); }
.lp-builder-steps .live { color: var(--acc-deep); font-weight: 600; }
.lp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: lppulse 1.6s infinite; }
@keyframes lppulse { 0%{ box-shadow: 0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent) } 70%{ box-shadow: 0 0 0 8px transparent } 100%{ box-shadow: 0 0 0 0 transparent } }

/* Precios */
.lp-price-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 20px; align-items: stretch; }
.lp-price { padding: 26px 24px; display: flex; flex-direction: column; }
.lp-price-feat { border-color: var(--acc); box-shadow: 0 20px 50px -28px color-mix(in srgb,var(--acc) 80%,transparent); position: relative; }
.lp-price-tag { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; font-size: 11.5px; font-weight: 700; color: var(--acc-deep); background: var(--acc-dim); border-radius: 999px; padding: 4px 11px; }
.lp-price-tag-free { color: var(--ok); background: color-mix(in srgb,var(--ok) 15%,transparent); }
.lp-price h3 { font-size: 20px; margin: 14px 0 4px; }
.lp-price-amount { font-size: 34px; margin: 0; font-weight: 600; } .lp-price-amount span { font-size: 15px; color: var(--ink-dim); font-weight: 400; }
.lp-price-note { margin: 6px 0 4px; font-size: 13px; color: var(--ink-dim); }
.lp-price .lp-check { margin: 14px 0 20px; } .lp-price .lp-check li { font-size: 13.5px; }
.lp-fineprint { font-size: 13.5px; color: var(--ink-dim); margin-top: 28px; }

/* FAQ */
.lp-faq { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.lp-faq-item { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--surface-solid); }
.lp-faq-item button { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 18px; background: none; border: none; color: var(--ink); font-size: 15px; font-weight: 600; text-align: left; cursor: pointer; }
.lp-faq-item svg { transition: transform .2s; color: var(--acc-deep); flex-shrink: 0; }
.lp-faq-item.open svg { transform: rotate(180deg); }
.lp-faq-a { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
.lp-faq-item.open .lp-faq-a { max-height: 240px; }
.lp-faq-a p { margin: 0; padding: 0 18px 16px; font-size: 14px; color: var(--ink-dim); line-height: 1.6; }

/* CTA final */
.lp-cta { padding: clamp(40px,6vw,70px) clamp(16px,4vw,40px); }
.lp-cta-inner { max-width: 860px; margin: 0 auto; text-align: center; background: linear-gradient(135deg, var(--acc-deep), var(--acc)); color: var(--acc-ink); border-radius: 28px; padding: clamp(36px,5vw,60px); }
.lp-cta-inner h2 { color: var(--acc-ink); margin: 0; } .lp-cta-inner .display-italic { opacity: .9; }
.lp-cta-inner p { font-size: 16px; margin: 14px 0 26px; opacity: .92; }

/* Footer */
.lp-footer { border-top: 1px solid var(--hairline); padding: 48px clamp(16px,4vw,40px) 28px; max-width: var(--lp-max); margin: 0 auto; }
.lp-footer-grid { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; gap: 28px; }
.lp-foot-tag { font-size: 13px; color: var(--ink-dim); margin: 8px 0 0; max-width: 30ch; line-height: 1.5; }
.lp-foot-h { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim); margin: 0 0 12px; }
.lp-footer-grid a { display: block; font-size: 14px; color: var(--ink-dim); text-decoration: none; padding: 4px 0; }
.lp-footer-grid a:hover { color: var(--acc-deep); }
.lp-foot-bottom { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 34px; padding-top: 20px; border-top: 1px solid var(--hairline); font-size: 12.5px; color: var(--ink-dim); }

/* Animación de entrada */
.lp-fade { animation: lpup .6s ease both; } .lp-fade-2 { animation-delay: .12s; }
@keyframes lpup { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }

/* Responsive */
@media (max-width: 900px) {
  .lp-hero-grid, .lp-split { grid-template-columns: 1fr; }
  .lp-hero-visual { order: -1; }
  .lp-strip { grid-template-columns: repeat(2,1fr); }
  .lp-steps, .lp-feats, .lp-price-grid { grid-template-columns: 1fr; }
  .lp-footer-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 680px) {
  .lp-links, .lp-nav-cta { display: none; }
  .lp-burger { display: inline-flex; }
  .lp-strip { grid-template-columns: 1fr; }
  .lp-footer-grid { grid-template-columns: 1fr; }
}
    `}</style>
  );
}
