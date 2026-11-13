"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, CreditCard, ExternalLink, FileText, History, Image as ImageIcon, Mic, Paperclip, MessageCircle, PenLine, Send, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import {
  MAX_ADJUNTOS,
  nombreCorto,
  pesoLegible,
  porQueNoPuedo,
  type AdjuntoListo,
  type TipoAdjunto,
} from "@/lib/adjuntos";
import { prepararAdjunto, puedeGrabar } from "@/lib/adjuntos-navegador";
import { contactoDeSoporte } from "@/lib/assistant";
import { COPILOT_ACTION_CSS, celebrar, renderMarkdown, resaltar, type AssistantAction } from "@/lib/copilot-actions";
import { ConviAvatar } from "@/components/ConviAvatar";
import {
  CONVI_NAME,
  INACTIVIDAD_MS,
  avisosProactivos,
  cartelDeConvi,
  chipsSugeridos,
  debeAbrirseSolo,
  debeOfrecerAyuda,
  dondeEsta,
  estadoDeConvi,
  saludoDeConvi,
  textoDeProgreso,
  type ConviCtx,
} from "@/lib/convi";

type Msg = {
  /** Id local (solo para reconciliar el envío optimista con su resultado). */
  id?: string;
  role: "user" | "assistant";
  content: string;
  actions?: AssistantAction[];
  /** E2.d - confirmacion pendiente de ESTE mensaje. Se apaga al responder. */
  confirmacion?: { id: string; texto: string } | null;
  /** Lo que el dueño le mostró en ese turno (para que su mensaje no se vea vacío). */
  adjuntos?: { tipo: TipoAdjunto; nombre: string }[];
  /** B3 — se está enviando (aparece al instante, antes de que el servidor conteste). */
  pendiente?: boolean;
  /** B3 — no se envió: el dueño puede reintentarlo sin volver a escribirlo. */
  fallo?: boolean;
};
/** Fecha corta para la lista del historial, en la hora de Chile (la del negocio). */
function fechaCorta(iso: string): string {
  try {
    return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** Un hilo del historial (B2). */
/**
 * E1.c — la pista del hilo abierto, por usuario, en el navegador.
 *
 * Sirve para pintar al instante mientras llega la red; la VERDAD es el hilo abierto del
 * usuario en la base, que es lo que permite retomar desde otro equipo. Va por usuario porque
 * un mismo navegador puede cambiar de cuenta y heredar el hilo ajeno sería peor que no tener
 * pista. Todo entre try: en modo privado `localStorage` lanza.
 */
const CLAVE_PISTA = "conversia:convi:thread";

function idDeUsuarioDelToken(): string {
  try {
    const t = localStorage.getItem("conversia_token") ?? "";
    const carga = JSON.parse(atob(t.split(".")[1] ?? "")) as { sub?: string };
    return carga?.sub ?? "anon";
  } catch {
    return "anon";
  }
}

function leerPista(): string | null {
  try {
    return localStorage.getItem(`${CLAVE_PISTA}:${idDeUsuarioDelToken()}`);
  } catch {
    return null;
  }
}

function guardarPista(id: string): void {
  try {
    localStorage.setItem(`${CLAVE_PISTA}:${idDeUsuarioDelToken()}`, id);
  } catch {
    /* modo privado */
  }
}

function limpiarPista(): void {
  try {
    localStorage.removeItem(`${CLAVE_PISTA}:${idDeUsuarioDelToken()}`);
  } catch {
    /* modo privado */
  }
}

type Hilo = { id: string; title: string | null; status: string; lastMessageAt: string; preview: string | null; userId?: string; userName?: string | null };
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
  /** B3 — el hilo donde se está conversando. Lo manda el servidor; acá solo se arrastra. */
  const [threadId, setThreadId] = useState<string | null>(null);
  /**
   * E1.c — PISTA del hilo en el navegador para pintar al instante mientras llega la red. No
   * es la verdad: la verdad es el hilo abierto del usuario en la base, que es lo que permite
   * retomar desde otro equipo. Si la pista apunta a un hilo que ya no está, se limpia.
   */
  const pistaRef = useRef<string | null>(null);
  const [hilos, setHilos] = useState<Hilo[] | null>(null);
  const [verHistorial, setVerHistorial] = useState(false);
  const [buscaHilos, setBuscaHilos] = useState("");
  const [cargandoHilo, setCargandoHilo] = useState(false);
  /** E1.a — con qué pedir los mensajes ANTERIORES. null = ya se ve el principio del hilo. */
  const [anteriores, setAnteriores] = useState<string | null>(null);
  const [cargandoAnteriores, setCargandoAnteriores] = useState(false);
  /**
   * E1.e — que el historial falle deja de ser invisible. Antes se tragaba el error y el dueño
   * veía una conversación vacía sin saber si Convi se olvidó o si no se pudo leer.
   */
  const [fallaHistorial, setFallaHistorial] = useState<null | "cargar" | "guardar">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [celebrando, setCelebrando] = useState(false);
  const [falloAlgo, setFalloAlgo] = useState(false);
  /** Convi no pudo: se ofrece una persona de verdad, con un botón que lleva a algún lado. */
  const [ofrecerSoporte, setOfrecerSoporte] = useState(false);
  const [avisoVisto, setAvisoVisto] = useState<string | null>(null);
  /** Hoja inferior COMPACTA (solo móvil): Convi se presenta sin tapar el panel. */
  const [compacto, setCompacto] = useState(false);
  /**
   * El acceso se ANUNCIA con palabras al llegar a una pantalla y se encoge al círculo en
   * cuanto el dueño toca algo. Sin esto, una píldora de 300px fija abajo a la derecha tapa
   * campos del formulario justo en las pantallas del montaje, que son las que se vienen a
   * llenar — la misma trampa del aviso de la PWA, que dejó de tapar el menú para pasar a
   * tapar un botón. Se encoge por INTERACCIÓN y no por un temporizador: así desaparece
   * exactamente cuando estorbaría, y no antes.
   */
  const [anunciando, setAnunciando] = useState(true);
  /** Lo que el dueño va a mostrarle en este mensaje (fotos, notas de voz, PDF). */
  const [adjuntos, setAdjuntos] = useState<AdjuntoListo[]>([]);
  /** Por qué un archivo no se pudo adjuntar, en lenguaje humano. */
  const [avisoAdjunto, setAvisoAdjunto] = useState<string | null>(null);
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const grabadoraRef = useRef<MediaRecorder | null>(null);
  const archivoRef = useRef<HTMLInputElement>(null);
  const adjuntosRef = useRef<AdjuntoListo[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const eligibleRef = useRef<boolean | null>(null);
  useEffect(() => { eligibleRef.current = eligible; }, [eligible]);
  useEffect(() => { adjuntosRef.current = adjuntos; }, [adjuntos]);

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
          if (!resaltar(a.target, a.text)) {
            window.setTimeout(() => {
              if (resaltar(a.target, a.text)) return;
              // Segundo intento fallido: el elemento NO está en esta pantalla (no cargó, o
              // esa tarjeta no se dibuja en esta cuenta). Antes esto terminaba en silencio
              // absoluto — Convi decía "te lo marco" y no se marcaba nada. Si sabemos en
              // qué pantalla vive, lo decimos con palabras y con el nombre que tiene en el
              // menú; si no lo sabemos, al menos queda dicha la indicación.
              const donde = dondeEsta(a.target);
              setMsgs((m) => [
                ...m,
                { role: "assistant", content: donde ? `${a.text}\n\nLo encuentras en **${donde}**.` : a.text },
              ]);
            }, 700);
          }
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
      // A3 — "probar=1" hace que Canales arranque la prueba sola: el dueño no tiene que
      // buscar el botón después de que Convi le dijo que probara.
      else if (a.kind === "whatsapp_test") router.push("/canales?probar=1");
      else if (a.kind === "interno" && a.payload) router.push(a.payload);
      else if (a.kind === "externo" && a.payload) window.open(a.payload, "_blank", "noopener,noreferrer");
    },
    [router],
  );

  const ask = useCallback(async (userText: string, archivos: AdjuntoListo[] = []) => {
    const body = userText.trim();
    // Un mensaje puede ser SOLO una foto o una nota de voz: exigir texto obligaba a
    // escribir "mira esto" para poder mandar lo que de verdad importa.
    if ((!body && !archivos.length) || busy) return;
    // B3 — el mensaje del dueño aparece AL INSTANTE y después se reconcilia con el
    // resultado. `history` ya no se manda: el historial lo arma el servidor desde la base.
    const idLocal = `l${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    setMsgs((m) => [...m, { id: idLocal, role: "user", content: body, adjuntos: archivos.map((a) => ({ tipo: a.tipo, nombre: a.nombre })), pendiente: true }]);
    setText("");
    setAdjuntos([]);
    setBusy(true);
    setFalloAlgo(false);
    setOfrecerSoporte(false);
    try {
      const r = await api<{ reply: string; wrote?: boolean; qa?: { passed: boolean } | null; actions?: AssistantAction[]; degradado?: boolean; threadId?: string; guardado?: boolean }>("/assistant/message", {
        method: "POST",
        body: JSON.stringify({
          message: body,
          route: pathname,
          ...(threadId ? { threadId } : {}),
          ...(archivos.length
            ? { adjuntos: archivos.map((a) => ({ tipo: a.tipo, nombre: a.nombre, mime: a.mime, dataBase64: a.dataBase64 })) }
            : {}),
        }),
      });
      // 200 con respuesta de respaldo: el proveedor de IA falló. Para el dueño esto es "Convi
      // está caído", así que ofrecemos una persona igual que en un error de red.
      if (r.degradado) setOfrecerSoporte(true);
      let reply = r.reply;
      if (r.wrote && r.qa) reply += r.qa.passed ? "\n\n(Probé tu asistente con los escenarios clave: todo en orden ✔)" : "\n\n(Hice el cambio; en la prueba quedó algo por revisar — te aviso si hace falta.)";
      const todas = r.actions ?? [];
      // E2.d - la confirmacion se saca de las acciones y se dibuja como su propio bloque: un
      // boton suelto que cobra se pulsa sin leer, y esto hay que LEERLO.
      const confirmacion = todas.find((a) => a.type === "confirm") as { type: "confirm"; id: string; texto: string } | undefined;
      const actions = todas.filter((a) => a.type !== "confirm");
      if (r.threadId) {
        setThreadId(r.threadId);
        guardarPista(r.threadId);
      }
      // E1.e — el servidor avisa si NO pudo guardar el turno. Antes se perdía en silencio y
      // el dueño lo descubría al reabrir y no encontrar nada.
      setFallaHistorial(r.guardado === false ? "guardar" : null);
      setMsgs((m) => [
        ...m.map((x) => (x.id === idLocal ? { ...x, pendiente: false } : x)),
        { role: "assistant", content: reply, actions: actions.filter((a) => a.type === "button"), confirmacion: confirmacion ? { id: confirmacion.id, texto: confirmacion.texto } : null },
      ]);
      ejecutarAcciones(actions);
    } catch (e) {
      // NUNCA mostrar el error técnico crudo al dueño (jamás un "(Not Found)"). Mensaje humano
      // y accionable; si hay WhatsApp de soporte lo ofrecemos como salida.
      const status = (e as { status?: number }).status;
      // 401 = sesión vencida: lib/api ya limpió la sesión y está redirigiendo a /login. NO es un
      // fallo del asistente → no mostramos nada (evita el falso "No pude responder" del hallazgo 26-oct).
      if (status === 401) return;
      // El mensaje del dueño queda MARCADO como no enviado, para que pueda reintentarlo sin
      // volver a escribirlo (y para que no crea que Convi lo recibió y no contestó).
      setMsgs((m) => m.map((x) => (x.id === idLocal ? { ...x, pendiente: false, fallo: true } : x)));
      setFalloAlgo(true);
      // Nada de "escríbele a soporte" dentro del soporte: salvo el 429 (que se resuelve solo
      // esperando), todo fallo ofrece el botón con el canal real.
      if (status !== 429) setOfrecerSoporte(true);
      const human =
        status === 429
          ? "Vamos un poco rápido 🙏. Espera unos segundos y escríbeme de nuevo."
          : status === 404 || status === 403
            ? "El asistente no está disponible en esta cuenta."
            : "No pude responder en este momento 🙏. Reintenta en unos segundos; si sigue, acá abajo te dejo cómo hablar con una persona del equipo.";
      setMsgs((m) => [...m, { role: "assistant", content: human }]);
    } finally {
      setBusy(false);
    }
  }, [busy, pathname, threadId, ejecutarAcciones]);

  /**
   * B3 — trae la conversación de la base. Sin `id` busca el hilo ABIERTO del dueño.
   *
   * Es lo que hace que cambiar de sección (el panel navega con <a href>, o sea recarga
   * entera) deje de borrar la conversación. Si falla, se empieza de cero sin mostrar un
   * error: no tener historial no es un problema que el dueño tenga que resolver.
   */
  /** E1.d — la carga EN VUELO, para que nadie escriba encima de ella. */
  const cargaEnVueloRef = useRef<Promise<void> | null>(null);

  const cargarHilo = useCallback(async (id?: string) => {
    setCargandoHilo(true);
    setFallaHistorial(null);
    try {
      let hiloId = id;
      if (!hiloId) {
        // E1.b — `mine=1`: solo MIS hilos. Un dueño es administrador y sin esto la lista traía
        // los de toda la organización; tomar «el primer hilo abierto» podía ser el de otra
        // persona, y al escribir el servidor respondía 404 (bien) mientras el widget decía
        // «El asistente no está disponible en esta cuenta» (pésimo).
        const r = await api<{ hilos: Hilo[] }>("/assistant/threads?limit=20&mine=1");
        setHilos(r.hilos);
        hiloId = r.hilos.find((h) => h.status === "open")?.id;
      }
      if (!hiloId) {
        limpiarPista();
        return;
      }
      // E1.a — SIN cursor: la última página. Antes traía los 50 más antiguos, así que pasados
      // ~25 turnos uno reabría y veía el principio de la conversación, nunca el final.
      const r = await api<{ messages: Array<{ role: string; content: string; actions?: unknown }>; anteriores?: string | null }>(
        `/assistant/threads/${hiloId}/messages`,
      );
      setThreadId(hiloId);
      guardarPista(hiloId);
      setAnteriores(r.anteriores ?? null);
      setMsgs(
        r.messages.map((m) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
          actions: Array.isArray(m.actions) ? (m.actions as AssistantAction[]).filter((a) => a.type === "button") : undefined,
        })),
      );
      setVerHistorial(false);
    } catch (e) {
      // E1.c — si el hilo ya no existe (lo archivaron, cambió de cuenta), la pista miente:
      // se limpia y se vuelve a pedir la lista, en vez de dejar al dueño con un error.
      const msg = String((e as Error)?.message ?? "");
      if (/404|no encontrada/i.test(msg) && id) {
        limpiarPista();
        setThreadId(null);
        await cargarHiloRef.current?.();
        return;
      }
      setFallaHistorial("cargar");
    } finally {
      setCargandoHilo(false);
    }
  }, []);

  /** Para poder reintentar desde dentro del propio `cargarHilo` sin pelear con las deps. */
  const cargarHiloRef = useRef<((id?: string) => Promise<void>) | null>(null);
  cargarHiloRef.current = cargarHilo;

  /**
   * E1.g — filtra por título, por lo primero que se dijo o por fecha. La fecha se compara
   * contra varias formas de escribirla («11-11», «11/11», «noviembre») porque nadie recuerda
   * el formato exacto con el que la pintamos.
   */
  const hilosFiltrados = useMemo(() => {
    const q = buscaHilos.trim().toLowerCase();
    if (!hilos) return [];
    if (!q) return hilos;
    return hilos.filter((h) => {
      const d = new Date(h.lastMessageAt);
      const fechas = [
        fechaCorta(h.lastMessageAt).toLowerCase(),
        d.toLocaleDateString("es-CL"),
        d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" }),
        d.toLocaleDateString("es-CL", { month: "long" }),
      ].join(" ");
      return `${h.title ?? ""} ${h.preview ?? ""} ${h.userName ?? ""} ${fechas}`.toLowerCase().includes(q);
    });
  }, [hilos, buscaHilos]);

  /** E1.g — reabre un hilo archivado como el activo (el servidor archiva el que estaba). */
  const retomarHilo = useCallback(
    async (id: string) => {
      try {
        await api(`/assistant/threads/${id}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) });
      } catch {
        /* si no se pudo reabrir, `cargarHilo` igual lo muestra en lectura */
      }
      await cargarHiloRef.current?.(id);
    },
    [],
  );

  /**
   * E2.d - el dueno confirma. Viaja SOLO el id: los argumentos estan guardados del lado del
   * servidor desde que se mostro el texto, asi que lo que se ejecuta es exactamente lo que se
   * leyo. Al responder, la confirmacion se apaga en el mensaje (no se pulsa dos veces).
   */
  const responderConfirmacion = useCallback(
    async (id: string, aceptar: boolean) => {
      setMsgs((m) => m.map((x) => (x.confirmacion?.id === id ? { ...x, confirmacion: null } : x)));
      if (!aceptar) {
        setMsgs((m) => [...m, { role: "assistant", content: "Listo, no hago nada entonces. Si cambias de idea, me dices." }]);
        return;
      }
      setBusy(true);
      try {
        const r = await api<{ ok: boolean; reply: string; actions?: AssistantAction[] }>("/assistant/confirm", {
          method: "POST",
          body: JSON.stringify({ id }),
        });
        setMsgs((m) => [...m, { role: "assistant", content: r.reply, actions: (r.actions ?? []).filter((a) => a.type === "button") }]);
        ejecutarAcciones(r.actions ?? []);
      } catch {
        setMsgs((m) => [...m, { role: "assistant", content: "No pude completarlo. Puedes intentarlo desde Cobros o pedirmelo de nuevo." }]);
      } finally {
        setBusy(false);
      }
    },
    [ejecutarAcciones],
  );

  /** E1.a — «Ver mensajes anteriores»: sube una página hacia atrás y la antepone. */
  const cargarAnteriores = useCallback(async () => {
    if (!threadId || !anteriores || cargandoAnteriores) return;
    setCargandoAnteriores(true);
    try {
      const r = await api<{ messages: Array<{ role: string; content: string; actions?: unknown }>; anteriores?: string | null }>(
        `/assistant/threads/${threadId}/messages?antesDe=${encodeURIComponent(anteriores)}`,
      );
      setAnteriores(r.anteriores ?? null);
      setMsgs((prev) => [
        ...r.messages.map((m) => ({
          role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content,
          actions: Array.isArray(m.actions) ? (m.actions as AssistantAction[]).filter((a) => a.type === "button") : undefined,
        })),
        ...prev,
      ]);
    } catch {
      setFallaHistorial("cargar");
    } finally {
      setCargandoAnteriores(false);
    }
  }, [threadId, anteriores, cargandoAnteriores]);

  /** Una sola carga por montaje del widget, la primera vez que se abre. */
  const hiloCargadoRef = useRef(false);
  useEffect(() => {
    if (!open || hiloCargadoRef.current) return;
    hiloCargadoRef.current = true;
    // E1.d — se guarda la promesa: `ask` la espera antes de agregar nada, porque si no
    // `setMsgs` de la carga PISA la pregunta recién escrita. Pasaba con el evento
    // `conversia:assistant:open`, que dispara una pregunta 120 ms después de abrir.
    cargaEnVueloRef.current = cargarHilo().finally(() => {
      cargaEnVueloRef.current = null;
    });
  }, [open, cargarHilo]);

  const nuevaConversacion = useCallback(async () => {
    try {
      const r = await api<{ id: string }>("/assistant/threads/new", { method: "POST", body: "{}" });
      setThreadId(r.id);
      setMsgs([]);
      setHilos(null);
      setVerHistorial(false);
    } catch {
      /* si falla, se sigue en la conversación actual */
    }
  }, []);

  const abrirHistorial = useCallback(async () => {
    setVerHistorial(true);
    try {
      const r = await api<{ hilos: Hilo[] }>("/assistant/threads?limit=20");
      setHilos(r.hilos);
    } catch {
      setHilos([]);
    }
  }, []);

  /** Reintenta un mensaje que no se envió, sin que el dueño lo vuelva a escribir. */
  const reintentar = useCallback(
    (m: Msg) => {
      setMsgs((prev) => prev.filter((x) => x.id !== m.id));
      void ask(m.content);
    },
    [ask],
  );

  /**
   * Suma archivos a lo que se va a mandar. Uno por uno y con su motivo: si el dueño
   * arrastra cinco cosas, las que entren entran y de las que no, se dice por qué.
   */
  const sumarArchivos = useCallback(async (archivos: File[]) => {
    if (!archivos.length) return;
    setAvisoAdjunto(null);
    const listos: AdjuntoListo[] = [];
    let aviso: string | null = null;
    // La cuenta se lleva en una variable y no leyendo el estado: `setAdjuntos` no se ve
    // reflejado hasta el siguiente render, así que con cinco archivos a la vez el límite
    // se comprobaba cinco veces contra el mismo cero y pasaban todos.
    let cuenta = adjuntosRef.current.length;
    for (const f of archivos) {
      const motivo = porQueNoPuedo(f, cuenta);
      if (motivo) {
        aviso = motivo;
        continue;
      }
      const listo = await prepararAdjunto(f).catch(() => null);
      if (!listo) {
        aviso = `No pude abrir “${f.name}”.`;
        continue;
      }
      listos.push(listo);
      cuenta += 1;
    }
    if (listos.length) setAdjuntos((prev) => [...prev, ...listos].slice(0, MAX_ADJUNTOS));
    if (aviso) setAvisoAdjunto(aviso);
  }, []);

  /**
   * PEGAR un pantallazo. Es la forma natural de mostrar un error o una pantalla de Meta:
   * se captura y se pega. Sin esto habría que guardar el archivo y buscarlo con el clip.
   */
  const alPegar = useCallback(
    (e: React.ClipboardEvent) => {
      const archivos = Array.from(e.clipboardData?.files ?? []);
      if (!archivos.length) return;
      e.preventDefault();
      void sumarArchivos(archivos);
    },
    [sumarArchivos],
  );

  /** Nota de voz: grabar / parar. Si el navegador no deja, el botón no se dibuja. */
  const alternarGrabacion = useCallback(async () => {
    if (grabadoraRef.current) {
      grabadoraRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const trozos: BlobPart[] = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) trozos.push(ev.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        grabadoraRef.current = null;
        setGrabando(false);
        const blob = new Blob(trozos, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1200) {
          setAvisoAdjunto("La nota de voz quedó muy corta.");
          return;
        }
        const ext = (rec.mimeType || "").includes("ogg") ? "ogg" : "webm";
        void sumarArchivos([new File([blob], `nota.${ext}`, { type: blob.type })]);
      };
      grabadoraRef.current = rec;
      setGrabando(true);
      setSegundos(0);
      rec.start();
    } catch {
      // Permiso denegado o sin micrófono: se dice y no se insiste.
      setAvisoAdjunto("No pude usar el micrófono. Revisa el permiso del navegador.");
      setGrabando(false);
      grabadoraRef.current = null;
    }
  }, [sumarArchivos]);

  // Contador de la grabación + corte duro: un minuto es de sobra para contarle algo a
  // Convi, y evita que un micrófono abierto por olvido termine en un archivo enorme.
  useEffect(() => {
    if (!grabando) return;
    const t = window.setInterval(() => {
      setSegundos((s) => {
        if (s + 1 >= 60) grabadoraRef.current?.stop();
        return s + 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [grabando]);

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
      if (detail?.context) {
        // Antes: `setTimeout(..., 120)` y a ver si llegaba. Ahora se ESPERA a que el historial
        // termine de cargar; si no hay carga en vuelo, sigue de inmediato.
        void (async () => {
          try {
            await cargaEnVueloRef.current;
          } catch {
            /* si falló, igual dejamos preguntar */
          }
          void ask(`Necesito ayuda con esto: ${detail.context}`);
        })();
      }
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

  // Al cambiar de pantalla Convi vuelve a presentarse; al primer toque se corre a un lado.
  useEffect(() => {
    setAnunciando(true);
    const callar = () => setAnunciando(false);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchmove"] as const) {
      window.addEventListener(ev, callar, { passive: true, once: true });
    }
    return () => {
      for (const ev of ["pointerdown", "keydown", "wheel", "touchmove"] as const) window.removeEventListener(ev, callar);
    };
  }, [pathname]);

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
  const cartel = ctx ? cartelDeConvi(ctx) : null;
  // El acceso habla… salvo en "Hoy", donde la TARJETA ya dice lo mismo: las dos cosas a la
  // vez muestran la misma frase dos veces en la misma pantalla, una encima de la otra, y
  // eso se lee como un error, no como insistencia.
  const accesoConPalabras = montaje && pathname !== "/inicio" && anunciando;
  const avisos = ctx && !montaje ? avisosProactivos(ctx) : [];
  const avisoPendiente = avisos.find((a) => a.key !== avisoVisto) ?? null;
  const pasosBloqueantes = (ctx?.steps ?? []).filter((s) => s.blocking);

  return (
    <>
      {!open ? (
        <button
          onClick={() => abrir()}
          aria-label={montaje && cartel ? `${CONVI_NAME}: ${cartel.pancarta}. ${textoDeProgreso(ctx!)}` : `${CONVI_NAME}, tu copiloto`}
          className={`cv-convi-acceso${accesoConPalabras ? " cv-convi-acceso-ancho" : ""}${pulse ? " cv-convi-pulse" : ""}`}
        >
          {/* El acceso lleva el avatar con su anillo de progreso, no un ícono genérico: el
              dueño ve de un vistazo cuánto le falta sin abrir nada. Y DURANTE EL MONTAJE
              lleva además las palabras: una carita sola no dice que ahí hay alguien que te
              arma el negocio conversando — es el mismo acertijo que eran los nueve iconos
              mudos del menú. Cuando el bot ya atiende vuelve a ser un acceso discreto. */}
          <ConviAvatar estado={pulse ? "saludando" : estado} size={accesoConPalabras ? 40 : 48} progreso={montaje ? ctx?.checklistPct ?? 0 : null} />
          {accesoConPalabras && cartel ? (
            <span className="cv-convi-acceso-texto">
              <span className="cv-convi-acceso-t1">{cartel.pancarta}</span>
              <span className="cv-convi-acceso-t2">{textoDeProgreso(ctx!)}</span>
            </span>
          ) : null}
          {avisoPendiente ? (
            <span aria-hidden="true" className="cv-convi-punto" style={{ background: avisoPendiente.urgente ? "var(--danger)" : "var(--acc-deep)" }} />
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
            {/* B3 — el hilo vive en la base, así que se puede empezar otro y volver a los
                anteriores. Dos botones chicos: el widget sigue siendo un widget. */}
            <button onClick={() => void nuevaConversacion()} data-convi="nueva-conversacion" title="Nueva conversación" aria-label="Nueva conversación" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }}><PenLine size={16} /></button>
            <button onClick={() => void (verHistorial ? setVerHistorial(false) : abrirHistorial())} data-convi="historial" title="Historial" aria-label="Historial" style={{ border: "none", background: "transparent", cursor: "pointer", color: verHistorial ? "var(--acc-deep)" : "var(--ink-dim)" }}><History size={16} /></button>
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
            {verHistorial ? (
              <div data-convi="lista-historial" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <p className="text-dim" style={{ fontSize: 12.5, margin: "0 0 2px" }}>Tus conversaciones</p>
                {/* E1.g — buscar. Con más de diez conversaciones, una lista por fecha deja de
                    servir: uno recuerda DE QUÉ habló, no cuándo. */}
                <input
                  value={buscaHilos}
                  onChange={(e) => setBuscaHilos(e.target.value)}
                  placeholder="Buscar por texto o fecha (ej. 11-11)"
                  data-testid="convi-buscar-hilos"
                  style={{ border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink)", borderRadius: 9, padding: "6px 9px", fontSize: 12.5, marginBottom: 2 }}
                />
                {hilos === null ? (
                  <p className="text-dim" style={{ fontSize: 13 }}>Buscando…</p>
                ) : hilosFiltrados.length === 0 ? (
                  <p className="text-dim" style={{ fontSize: 13 }}>
                    {buscaHilos.trim() ? "Nada que coincida con eso." : "Todavía no hay conversaciones guardadas."}
                  </p>
                ) : (
                  hilosFiltrados.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => void cargarHilo(h.id)}
                      style={{ textAlign: "left", border: "1px solid var(--hairline)", background: h.id === threadId ? "var(--acc-dim)" : "transparent", borderRadius: 11, padding: "9px 11px", cursor: "pointer", color: "var(--ink)" }}
                    >
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, fontWeight: 600 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.title ?? "Sin título"}</span>
                        <span className="text-dim" style={{ fontSize: 11.5, fontWeight: 400, whiteSpace: "nowrap" }}>{fechaCorta(h.lastMessageAt)}</span>
                      </span>
                      {h.preview ? <span className="text-dim" style={{ display: "block", fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.preview}</span> : null}
                      {h.userName ? <span className="text-dim" style={{ display: "block", fontSize: 11, marginTop: 2 }}>de {h.userName}</span> : null}
                      {/* E1.g — una conversación archivada se puede RETOMAR: vuelve a ser la
                          activa y la de ahora se archiva. Antes solo se podía leer. */}
                      {h.status !== "open" ? (
                        <span
                          role="button"
                          tabIndex={0}
                          data-testid="convi-retomar"
                          onClick={(e) => { e.stopPropagation(); void retomarHilo(h.id); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void retomarHilo(h.id); } }}
                          style={{ display: "inline-block", marginTop: 6, fontSize: 11.5, color: "var(--acc)", textDecoration: "underline" }}
                        >
                          Retomar
                        </span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {!verHistorial && msgs.length === 0 && !cargandoHilo ? <p className="text-dim" style={{ fontSize: 13 }}>Escríbeme y te ayudo a dejar tu asistente andando o resuelvo tus dudas.</p> : null}
            {!verHistorial && cargandoHilo && msgs.length === 0 ? <p className="text-dim" style={{ fontSize: 13 }}>Recuperando nuestra conversación…</p> : null}
            {/* E1.a — subir hacia atrás. Solo aparece cuando hay más arriba: un botón que no
                hace nada es peor que ninguno. */}
            {!verHistorial && anteriores ? (
              <button
                onClick={() => void cargarAnteriores()}
                disabled={cargandoAnteriores}
                data-testid="convi-anteriores"
                style={{ alignSelf: "center", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-dim)", borderRadius: 999, padding: "3px 12px", fontSize: 11.5, cursor: "pointer" }}
              >
                {cargandoAnteriores ? "Buscando…" : "Ver mensajes anteriores"}
              </button>
            ) : null}
            {/* E1.e — que el historial falle deja de ser invisible. Discreto, con salida. */}
            {!verHistorial && fallaHistorial ? (
              <div
                data-testid="convi-falla-historial"
                style={{ alignSelf: "center", display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--ink-dim)" }}
              >
                <span>{fallaHistorial === "cargar" ? "No pude recuperar el historial." : "No pude guardar este mensaje."}</span>
                <button
                  onClick={() => void (fallaHistorial === "cargar" ? cargarHilo(threadId ?? undefined) : cargarHilo(threadId ?? undefined))}
                  style={{ border: "none", background: "none", color: "var(--acc)", cursor: "pointer", fontSize: 11.5, textDecoration: "underline", padding: 0 }}
                >
                  Reintentar
                </button>
              </div>
            ) : null}
            {(verHistorial ? [] : msgs).map((m, i) => {
              const mine = m.role === "user";
              return (
                <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  {/* COP 1 — el markdown se RENDERIZA (negritas, listas, enlaces internos).
                      Antes se aplanaba, y "te falta **conectar tu WhatsApp**" perdía justo
                      el énfasis que marca la acción. `aria-live` para los lectores. */}
                  <div
                    aria-live={mine ? undefined : "polite"}
                    style={{ padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.45, wordBreak: "break-word", background: mine ? "var(--acc)" : "var(--surface-solid)", color: mine ? "var(--acc-ink)" : "var(--ink)", border: mine ? "none" : "1px solid var(--hairline)", opacity: m.pendiente ? 0.65 : 1 }}
                  >
                    {mine ? (
                      <>
                        {/* Lo que le mostró: sin esto, un mensaje que es SOLO una foto o una
                            nota de voz aparecía como una burbuja vacía. */}
                        {m.adjuntos?.length ? (
                          <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: m.content ? 6 : 0 }}>
                            {m.adjuntos.map((a, k) => (
                              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, opacity: 0.9 }}>
                                {a.tipo === "imagen" ? <ImageIcon size={12} /> : a.tipo === "audio" ? <Mic size={12} /> : <FileText size={12} />}
                                {a.tipo === "audio" ? "Nota de voz" : nombreCorto(a.nombre, 22)}
                              </span>
                            ))}
                          </span>
                        ) : null}
                        {m.content ? <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span> : null}
                      </>
                    ) : (
                      renderMarkdown(m.content)
                    )}
                  </div>
                  {/* B3 — el mensaje no se envió: se dice y se ofrece reintentar, en vez de
                      dejarlo en pantalla como si Convi lo hubiera recibido y no contestara. */}
                  {mine && m.fallo ? (
                    <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, fontSize: 11.5, marginTop: 3, color: "var(--danger)" }}>
                      No se envió
                      <button onClick={() => reintentar(m)} data-convi="reintentar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--acc-deep)", fontSize: 11.5, textDecoration: "underline", padding: 0 }}>
                        Reintentar
                      </button>
                    </span>
                  ) : null}
                  {/* Botones del copiloto: pagar y conectar WhatsApp SOLO pasan por acá, con
                      el clic del dueño (el popup de Meta se bloquea si no nace de un clic). */}
                  {/* E2.d - CONFIRMAR. Va antes que los botones y se ve distinto a proposito:
                      esto cuesta plata o borra algo, y tiene que leerse, no pulsarse de paso. */}
                  {m.confirmacion ? (
                    <div
                      data-testid="convi-confirmacion"
                      style={{ marginTop: 7, border: "1px solid var(--acc)", borderRadius: 12, padding: "9px 11px", background: "var(--acc-dim)" }}
                    >
                      <p style={{ margin: "0 0 8px", fontSize: 12.5, lineHeight: 1.4 }}>{m.confirmacion.texto}</p>
                      <div style={{ display: "flex", gap: 7 }}>
                        <button
                          onClick={() => void responderConfirmacion(m.confirmacion!.id, true)}
                          disabled={busy}
                          className="btn-accent"
                          data-testid="convi-confirmar"
                          style={{ border: "none", cursor: "pointer", fontSize: 12, padding: "5px 13px" }}
                        >
                          Confirmar
                        </button>
                        <button
                          onClick={() => void responderConfirmacion(m.confirmacion!.id, false)}
                          disabled={busy}
                          style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--ink-dim)", borderRadius: 999, cursor: "pointer", fontSize: 12, padding: "5px 11px" }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {m.actions?.length ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      {m.actions.map((a, j) =>
                        a.type === "button" ? (
                          <button key={j} onClick={() => tocarBoton(a)} className="btn-accent" style={{ border: "none", cursor: "pointer", fontSize: 12.5, padding: "7px 12px", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {a.kind === "pago" ? <CreditCard size={14} /> : a.kind === "whatsapp" || a.kind === "whatsapp_test" ? <MessageCircle size={14} /> : a.kind === "externo" ? <ExternalLink size={14} /> : null}
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
            {/* SALIDA REAL cuando Convi no puede. Antes el mensaje decía "escríbele a soporte"
                dentro de la ventana que ES el soporte: un callejón sin salida justo cuando algo
                ya había fallado. `contactoDeSoporte` siempre devuelve un canal (WhatsApp si está
                configurado, correo si no), así que este botón nunca queda sin destino. */}
            {ofrecerSoporte && !busy ? (
              <a
                href={contactoDeSoporte(`Convi no responde (estaba en ${pathname})`).url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-accent"
                style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, padding: "8px 13px", borderRadius: 10, textDecoration: "none", marginTop: 2 }}
              >
                <MessageCircle size={14} /> {contactoDeSoporte().etiqueta}
              </a>
            ) : null}
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

          {/* MOSTRARLE las cosas en vez de escribirlas: fotos y pantallazos, notas de voz,
              PDF y planillas. Las fichas de lo adjuntado van arriba del compositor para que
              se vea qué se va a mandar y se pueda sacar antes de enviar. */}
          {adjuntos.length || avisoAdjunto ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 10px 6px" }}>
              {adjuntos.map((a, i) => (
                <span key={`${a.nombre}-${i}`} className="card" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "5px 8px", borderRadius: 9 }}>
                  {a.tipo === "imagen" ? <ImageIcon size={13} /> : a.tipo === "audio" ? <Mic size={13} /> : <FileText size={13} />}
                  {a.tipo === "audio" ? "Nota de voz" : nombreCorto(a.nombre)}
                  <span className="text-dim">{pesoLegible(a.bytes)}</span>
                  <button
                    type="button"
                    onClick={() => setAdjuntos((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Quitar ${a.nombre}`}
                    style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", lineHeight: 0, padding: 0 }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {avisoAdjunto ? <span className="text-dim" style={{ fontSize: 11.5, alignSelf: "center" }} role="status">{avisoAdjunto}</span> : null}
            </div>
          ) : null}

          <form onSubmit={(e) => { e.preventDefault(); void ask(text, adjuntos); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: 10, borderTop: "1px solid var(--hairline)" }}>
            <input
              ref={archivoRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,.md,.csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { void sumarArchivos(Array.from(e.target.files ?? [])); e.target.value = ""; }}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => archivoRef.current?.click()}
              disabled={busy || adjuntos.length >= MAX_ADJUNTOS}
              aria-label="Adjuntar una foto, un PDF o una planilla"
              title="Adjuntar una foto, un PDF o una planilla"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", lineHeight: 0, padding: 6, opacity: busy || adjuntos.length >= MAX_ADJUNTOS ? 0.4 : 1 }}
            >
              <Paperclip size={17} />
            </button>
            {puedeGrabar() ? (
              <button
                type="button"
                onClick={() => void alternarGrabacion()}
                disabled={busy || (!grabando && adjuntos.length >= MAX_ADJUNTOS)}
                aria-label={grabando ? "Terminar la nota de voz" : "Grabar una nota de voz"}
                title={grabando ? "Terminar la nota de voz" : "Grabar una nota de voz"}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: grabando ? "var(--danger)" : "var(--ink-dim)", lineHeight: 0, padding: 6, opacity: busy ? 0.4 : 1 }}
              >
                {grabando ? <Square size={16} /> : <Mic size={17} />}
              </button>
            ) : null}
            {grabando ? (
              <span role="status" style={{ fontSize: 12.5, color: "var(--danger)", fontVariantNumeric: "tabular-nums", flex: 1 }}>
                Grabando… {String(Math.floor(segundos / 60)).padStart(2, "0")}:{String(segundos % 60).padStart(2, "0")}
              </span>
            ) : (
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={alPegar}
                placeholder={cargandoHilo ? "Recuperando tu conversación…" : `Escríbele a ${CONVI_NAME}…`}
                aria-label={`Mensaje para ${CONVI_NAME}`}
                style={{ flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }}
              />
            )}
            <button className="btn-accent" type="submit" disabled={busy || grabando || (!text.trim() && !adjuntos.length)} style={{ borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", flexShrink: 0, opacity: busy || grabando || (!text.trim() && !adjuntos.length) ? 0.5 : 1 }} aria-label="Enviar"><Send size={16} /></button>
          </form>
        </div>
      )}
      <style>{`
.cv-convi-pulse { animation: cvasst 1.8s ease-in-out 2; }
@keyframes cvasst { 0%,100% { box-shadow: var(--shadow); } 50% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--acc) 30%, transparent); } }
/* EL ACCESO. Redondo y mudo cuando ya está todo andando; con palabras mientras falte
   montaje. Se apoya POR ENCIMA de la barra de pestañas (62px): en teléfono esa barra es
   toda la navegación que hay, y lo que se apoye encima se come el toque sin que se vea
   nada raro en pantalla. Lo ata nada-tapa-la-barra.test.ts.
   El 78 es EL MISMO que tenía antes y no se toca a la ligera: subirlo a 86 (copiando el
   de la burbuja compacta, que necesita margen por su animación de entrada) movió el acceso
   8px y pasó a comerse el clic del botón "Reintentar" de la tarjeta de saldo en iPhone.
   Una barra fija abajo SIEMPRE tapa algo: lo único que cambia es qué. El inset de iOS va
   sumado porque la barra también lo suma — si no, en un iPhone de verdad quedan 16px menos.
   (Sin acentos graves acá dentro: esto vive en un template literal de JS y una comilla
   invertida en un comentario de CSS corta el literal y rompe el build.) */
.cv-convi-acceso {
  position: fixed; right: 18px; bottom: calc(78px + env(safe-area-inset-bottom, 0px));
  z-index: 40; display: flex; align-items: center; gap: 10px; padding: 7px;
  width: 56px; height: 56px; justify-content: center; border-radius: 999px;
  background: var(--surface-solid); border: 1px solid var(--line); box-shadow: var(--shadow);
  cursor: pointer; color: var(--ink); text-align: left;
}
.cv-convi-acceso-ancho {
  width: auto; height: auto; justify-content: flex-start; padding: 8px 16px 8px 8px;
  max-width: min(300px, calc(100vw - 36px)); border-color: var(--acc);
}
.cv-convi-acceso-texto { display: flex; flex-direction: column; min-width: 0; }
.cv-convi-acceso-t1 { font-size: 13px; font-weight: 650; line-height: 1.25; }
.cv-convi-acceso-t2 { font-size: 11.5px; color: var(--ink-dim); line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cv-convi-punto { position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--surface-solid); }
/* Panel ACOPLADO a la derecha en escritorio; HOJA INFERIOR en móvil. El breakpoint es EL
   MISMO que el del armazón (768px, globals.css): riel a la izquierda arriba de eso,
   pestañas abajo. Si se desalinean, en tablet el panel se solapa con la tab bar. */
/* Fondo SÓLIDO y no el vidrio de .card: hasta 1099px el panel se superpone al contenido en
   vez de correrlo, y con el 4% de blanco del vidrio se leía la pantalla de atrás a través
   de la conversación. Es el mismo arreglo que necesitó la hoja "Más" del menú. */
/* 50: por ENCIMA de la barra de pestañas (45). Esta hoja sí la tapa a propósito — ocupa
   78dvh, la abrió el dueño y se cierra con su X o con Escape. El acceso (40) y la burbuja
   (41) se quedan DEBAJO: son avisos, no hojas, y si alguna vez rozan la barra el toque
   tiene que seguir siendo del menú. */
.cv-convi-panel { position: fixed; z-index: 50; display: flex; flex-direction: column; padding: 0; overflow: hidden; background: var(--surface-solid); }
@media (min-width: 768px) {
  .cv-convi-panel { right: 16px; top: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px)); }
}
@media (max-width: 767px) {
  .cv-convi-panel { left: 0; right: 0; bottom: 0; top: auto; height: min(78dvh, 640px); border-radius: 18px 18px 0 0; border-left: none; border-right: none; border-bottom: none; }
  .cv-convi-panel { animation: cvsheet .22s ease-out; }
}
@keyframes cvsheet { from { transform: translateY(16px); opacity: .7; } to { transform: translateY(0); opacity: 1; } }
/* COMPACTO: barra baja, por encima de la tab bar y de su safe-area. No tapa el panel.
   El 86 no es un número al azar: 62 de la barra de pestañas + 16 que la ENTRADA baja el
   elemento (la animación cvsheet arranca en translateY(16px)) + 8 de aire. Quieto con 70 no
   tapaba nada, pero durante esos 0,22 s de entrada se metía 8px sobre la barra y se comía
   el toque en los ítems del menú: en CI el clic en "Más" falló 45 s seguidos y Playwright
   señaló a "Empecemos" como el que interceptaba. Lo ata nada-tapa-la-barra.test.ts. */
.cv-convi-peek {
  position: fixed; z-index: 41; left: 10px; right: 10px;
  bottom: calc(86px + env(safe-area-inset-bottom, 0px));
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 15px;
  animation: cvsheet .22s ease-out;
}
@media (prefers-reduced-motion: reduce) { .cv-convi-panel, .cv-convi-peek, .cv-convi-pulse { animation: none !important; } }
${COPILOT_ACTION_CSS}`}</style>
    </>
  );
}
