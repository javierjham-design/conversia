import { getEnv, withAppSecretProof } from "@conversia/config";

/**
 * A1 — REPORTE DE CONEXIÓN DE UN CANAL.
 *
 * Brecha que cierra (reproducida en el stack local el 10-nov-2026, ver el PR): recién
 * conectado, el panel se veía igual que antes por tres caminos distintos, y no existía ningún
 * lugar donde el dueño pudiera leer en qué estado quedó su número. Lo único que había era
 * `POST /channels/:id/test`, que devuelve UNA frase.
 *
 * Diseño: el armado del reporte es PURO (`armarReporte`) y recibe ya resueltas las respuestas
 * de Graph, la fila del canal y la última actividad. Así las decisiones —qué está mal, qué se
 * puede hacer— se prueban con fixtures y sin red, que es donde se esconden los errores; el
 * servicio se encarga del IO y de la caché.
 *
 * Regla que vale para todo este archivo: **ni un token sale en el reporte**. Lo que se devuelve
 * va directo a la pantalla del cliente.
 */

/** Un punto verificable del canal. `ok=false` significa "hay algo que hacer". */
export interface ChequeoDeCanal {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Qué hacer para arreglarlo (solo cuando hay una acción concreta del cliente). */
  fix?: string;
  /**
   * No se pudo averiguar (Meta no respondió, el canal no tiene token para preguntar).
   *
   * Existe porque un `ok: false` a secas pintaría una cruz roja alarmante sobre una cuenta
   * sana cuando Graph tiene un hipo, y un `ok: true` mentiría diciendo que se verificó algo
   * que no se verificó. La pantalla lo muestra en gris.
   */
  unknown?: boolean;
}

export type ModoDeCanal = "coexistence" | "dedicated";

export interface ReporteDeCanal {
  channelId: string;
  channelType: string;
  channelName: string;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: "GREEN" | "YELLOW" | "RED" | null;
  mode: ModoDeCanal;
  coexVerified: boolean;
  pendingNumber: boolean;
  wabaId: string | null;
  channelStatus: string;
  tokenHealthy: boolean;
  accountAlert: { type: string; message: string | null; at: string } | null;
  /** null = no se pudo consultar a Meta. */
  webhookSubscribed: boolean | null;
  defaultAgent: { id: string; name: string } | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  checks: ChequeoDeCanal[];
  /**
   * C1 — canales de página (Instagram/Messenger): ¿Meta ya aprobó la App Review de
   * mensajería? Con `false`, solo llegan los DM de cuentas CON ROL en la app. `null` en
   * WhatsApp, donde no aplica.
   */
  reviewApproved?: boolean | null;
  /** C1 — nombre de la página de Facebook (canales de página). */
  pageName?: string | null;
}

/** Lo que Graph dice del número (una sola llamada, compartida con `POST /channels/:id/test`). */
export interface DatosDelNumero {
  ok: boolean;
  tokenVencido: boolean;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  /** El número vive en la app de WhatsApp Business del cliente (coexistencia confirmada). */
  coexVerified: boolean;
  error: string | null;
}

export interface SuscripcionDeWaba {
  /** null = no se pudo preguntar. */
  suscrita: boolean | null;
  campos: string[];
  /** Otras apps suscritas a la misma WABA (posible receptor principal de los mensajes). */
  otras: string[];
}

type FetchLike = typeof fetch;

/**
 * Campos del número en UNA sola llamada: los tres que ya pedía la prueba del canal más los
 * dos que distinguen coexistencia de número dedicado. Pedirlos juntos es la razón de que el
 * reporte completo cueste dos llamadas a Graph y no cuatro.
 */
export const CAMPOS_DEL_NUMERO = "display_phone_number,verified_name,quality_rating,platform_type,is_on_biz_app";

export async function consultarNumero(phoneNumberId: string, token: string, fetchImpl: FetchLike = fetch): Promise<DatosDelNumero> {
  const v = getEnv().META_GRAPH_VERSION;
  try {
    const url = `https://graph.facebook.com/${v}/${encodeURIComponent(phoneNumberId)}?fields=${CAMPOS_DEL_NUMERO}`;
    const res = await fetchImpl(withAppSecretProof(url, token), { headers: { authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    // §4.2 — un 190 es token vencido/revocado y NO se reintenta con el token de la
    // plataforma: eso sería operar la WABA del cliente con credenciales ajenas.
    const tokenVencido = !res.ok && (json?.error?.code === 190 || res.status === 401);
    if (!res.ok) {
      return {
        ok: false,
        tokenVencido,
        displayPhone: null,
        verifiedName: null,
        qualityRating: null,
        coexVerified: false,
        error: tokenVencido ? "El acceso con Meta venció o fue revocado." : (json?.error?.message ?? `Meta respondió ${res.status}`),
      };
    }
    return {
      ok: true,
      tokenVencido: false,
      displayPhone: (json.display_phone_number as string) ?? null,
      verifiedName: (json.verified_name as string) ?? null,
      qualityRating: (json.quality_rating as string) ?? null,
      coexVerified: json.is_on_biz_app === true && String(json.platform_type ?? "").toUpperCase() === "CLOUD_API",
      error: null,
    };
  } catch (err) {
    return { ok: false, tokenVencido: false, displayPhone: null, verifiedName: null, qualityRating: null, coexVerified: false, error: `Error de red: ${(err as Error).message}` };
  }
}

/** ¿Meta nos manda los mensajes de esta WABA? (`GET {waba_id}/subscribed_apps`). */
export async function consultarSuscripcionWaba(wabaId: string, token: string, appId: string, fetchImpl: FetchLike = fetch): Promise<SuscripcionDeWaba> {
  const v = getEnv().META_GRAPH_VERSION;
  try {
    const url = `https://graph.facebook.com/${v}/${encodeURIComponent(wabaId)}/subscribed_apps`;
    const res = await fetchImpl(withAppSecretProof(url, token), { headers: { authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, any>>; error?: Record<string, any> };
    if (!res.ok || !Array.isArray(json?.data)) return { suscrita: null, campos: [], otras: [] };
    // Graph devuelve la app como `whatsapp_business_api_data: { id, name }`.
    const apps = json.data.map((a) => a?.whatsapp_business_api_data ?? a);
    const mia = apps.find((a) => String(a?.id ?? "") === String(appId));
    return {
      suscrita: Boolean(mia),
      campos: Array.isArray(mia?.subscribed_fields) ? mia.subscribed_fields.map(String) : [],
      otras: apps.filter((a) => String(a?.id ?? "") !== String(appId)).map((a) => String(a?.name ?? a?.id ?? "")).filter(Boolean),
    };
  } catch {
    return { suscrita: null, campos: [], otras: [] };
  }
}

/** Lo que Graph dice de una página de Facebook (Messenger/Instagram). */
export interface DatosDeLaPagina {
  ok: boolean;
  nombre: string | null;
  /** null = no se pudo preguntar. */
  suscrita: boolean | null;
  campos: string[];
  otras: string[];
  error: string | null;
}

/**
 * Acceso a la página + suscripción de la app, en dos llamadas. Es la MISMA comprobación que
 * hace `POST /channels/:id/test` para estos canales: el token de página se deriva del token
 * de la conexión de Meta del tenant, y sin el campo `messages` los DM no llegan nunca.
 */
export async function consultarPagina(pageId: string, crmToken: string, appId: string, fetchImpl: FetchLike = fetch): Promise<DatosDeLaPagina> {
  const v = getEnv().META_GRAPH_VERSION;
  const vacio = { ok: false, nombre: null, suscrita: null, campos: [], otras: [] };
  try {
    const pRes = await fetchImpl(
      withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(pageId)}?fields=name,access_token`, crmToken),
      { headers: { authorization: `Bearer ${crmToken}` } },
    );
    const pJson = (await pRes.json().catch(() => ({}))) as Record<string, any>;
    if (!pRes.ok || !pJson.access_token) {
      return { ...vacio, error: pJson?.error?.message ?? "Sin acceso de administración a la página" };
    }
    const token = String(pJson.access_token);
    const sRes = await fetchImpl(
      withAppSecretProof(`https://graph.facebook.com/${v}/${encodeURIComponent(pageId)}/subscribed_apps`, token),
      { headers: { authorization: `Bearer ${token}` } },
    );
    const sJson = (await sRes.json().catch(() => ({}))) as { data?: Array<Record<string, any>> };
    if (!sRes.ok || !Array.isArray(sJson.data)) {
      return { ok: true, nombre: String(pJson.name ?? ""), suscrita: null, campos: [], otras: [], error: null };
    }
    const mia = sJson.data.find((a) => String(a?.id ?? "") === String(appId));
    return {
      ok: true,
      nombre: String(pJson.name ?? ""),
      suscrita: Boolean(mia),
      campos: Array.isArray(mia?.subscribed_fields) ? mia.subscribed_fields.map(String) : [],
      otras: sJson.data.filter((a) => String(a?.id ?? "") !== String(appId)).map((a) => String(a?.name ?? a?.id ?? "")).filter(Boolean),
      error: null,
    };
  } catch (err) {
    return { ...vacio, error: `Error de red: ${(err as Error).message}` };
  }
}

export interface EntradaDelReporte {
  canal: { id: string; type: string; name: string; status: string; config: Record<string, unknown> };
  defaultAgent: { id: string; name: string } | null;
  /** Fila local del número (null = canal waba-only, el número aún no llegó). */
  numeroLocal: { phoneNumberId: string; displayPhone: string | null } | null;
  wabaId: string | null;
  /** Respuesta de Graph (null = no se pudo preguntar: sin token o sin número). */
  graph: DatosDelNumero | null;
  suscripcion: SuscripcionDeWaba | null;
  /** Último evento de salud con severidad warning/error (lo acota el servicio a 7 días). */
  accountAlert: { type: string; message: string | null; at: string } | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** El canal no tiene token propio cargado (§4.2: no se cae al token de la plataforma). */
  sinToken: boolean;
  /** C1 — canales de página: lo que Graph dice de la página (null si no se pudo preguntar). */
  pagina?: DatosDeLaPagina | null;
  /** C1 — ¿Meta aprobó la App Review de mensajería? (solo canales de página). */
  reviewApproved?: boolean;
}

const CALIDADES = new Set(["GREEN", "YELLOW", "RED"]);

/** Fecha legible para el dueño, en la hora de Chile (la del negocio). */
function cuando(iso: string | null): string {
  if (!iso) return "sin registro";
  try {
    return new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return "sin registro";
  }
}

/**
 * Arma el reporte. PURO: ninguna llamada, ninguna fecha "ahora", nada de azar — la misma
 * entrada da siempre el mismo reporte, que es lo que lo hace comprobable.
 */
/** Canales que viven en una página de Facebook (sus chequeos son otros). */
export function esCanalDePagina(tipo: string): boolean {
  return tipo === "INSTAGRAM" || tipo === "MESSENGER";
}

/**
 * C1 — reporte de un canal de Instagram o Messenger.
 *
 * Lo que puede fallar acá no es un número ni una calidad: es el ACCESO a la página, que la
 * app esté suscrita al campo `messages` (sin eso los DM no llegan nunca), que haya alguien
 * atendiendo, y que Meta haya aprobado la App Review — que no es un problema del cliente y
 * por eso no se cuenta como fallo suyo.
 */
function reporteDePagina(e: EntradaDelReporte): ReporteDeCanal {
  const cfg = e.canal.config ?? {};
  const p = e.pagina ?? null;
  const checks: ChequeoDeCanal[] = [];

  if (!p) {
    checks.push({ key: "pagina", label: "Tu página está conectada", ok: false, unknown: true, detail: "No pudimos comprobarlo ahora." });
  } else if (!p.ok) {
    checks.push({
      key: "pagina",
      label: "Tu página está conectada",
      ok: false,
      detail: p.error ?? "No tenemos acceso de administración a la página.",
      fix: "Vuelve a conectar la página desde Canales y autorízala en la ventana de Meta.",
    });
  } else {
    checks.push({ key: "pagina", label: "Tu página está conectada", ok: true, detail: p.nombre ?? e.canal.name });
  }

  if (!p || p.suscrita === null) {
    checks.push({ key: "webhook", label: "Meta nos avisa de tus mensajes", ok: false, unknown: true, detail: "No pudimos comprobarlo ahora." });
  } else if (!p.suscrita) {
    checks.push({
      key: "webhook",
      label: "Meta nos avisa de tus mensajes",
      ok: false,
      detail: "Meta no nos está avisando de los mensajes de esta página, así que tu asistente no los ve.",
      fix: "Vuelve a conectar la página: la reconexión deja el aviso configurado.",
    });
  } else if (!p.campos.includes("messages")) {
    checks.push({
      key: "webhook",
      label: "Meta nos avisa de tus mensajes",
      ok: false,
      detail: `La página está conectada, pero sin el permiso de mensajes (${p.campos.join(", ") || "sin campos"}).`,
      fix: "Vuelve a conectar la página aceptando los permisos de mensajería.",
    });
  } else {
    const otras = p.otras.length ? ` · ⚠ otra app también está conectada (${p.otras.join(", ")}) y podría estar recibiendo los mensajes` : "";
    checks.push({ key: "webhook", label: "Meta nos avisa de tus mensajes", ok: true, detail: `Avisos activos${otras}` });
  }

  if (e.defaultAgent) {
    checks.push({ key: "asistente", label: "Un asistente atiende este canal", ok: true, detail: `Atiende ${e.defaultAgent.name}` });
  } else {
    checks.push({
      key: "asistente",
      label: "Un asistente atiende este canal",
      ok: false,
      detail: "Nadie está asignado a este canal, así que los mensajes llegan y quedan sin responder.",
      fix: "Asigna tu asistente desde esta misma pantalla.",
    });
  }

  return {
    channelId: e.canal.id,
    channelType: e.canal.type,
    channelName: e.canal.name,
    displayPhone: null,
    verifiedName: null,
    qualityRating: null,
    mode: "dedicated",
    coexVerified: false,
    pendingNumber: false,
    wabaId: null,
    channelStatus: e.canal.status,
    // Para estos canales el "acceso vigente" es el de la página.
    tokenHealthy: p?.ok !== false,
    accountAlert: e.accountAlert,
    webhookSubscribed: p?.suscrita ?? null,
    defaultAgent: e.defaultAgent,
    lastInboundAt: e.lastInboundAt,
    lastOutboundAt: e.lastOutboundAt,
    checks,
    reviewApproved: e.reviewApproved ?? false,
    pageName: p?.nombre ?? (typeof cfg.pageName === "string" ? cfg.pageName : null),
  };
}

export function armarReporte(e: EntradaDelReporte): ReporteDeCanal {
  if (esCanalDePagina(e.canal.type)) return reporteDePagina(e);
  const cfg = e.canal.config ?? {};
  const pendingNumber = cfg.pendingNumber === true || (!e.numeroLocal && !e.graph?.displayPhone);
  const mode: ModoDeCanal = cfg.coexistence === true ? "coexistence" : "dedicated";
  const displayPhone = e.graph?.displayPhone ?? e.numeroLocal?.displayPhone ?? null;
  const qualityRating = e.graph?.qualityRating && CALIDADES.has(e.graph.qualityRating.toUpperCase())
    ? (e.graph.qualityRating.toUpperCase() as "GREEN" | "YELLOW" | "RED")
    : null;
  const coexVerified = e.graph?.coexVerified ?? cfg.coexVerified === true;
  const tokenVencido = e.graph?.tokenVencido === true;
  const tokenHealthy = !e.sinToken && !tokenVencido && e.canal.status !== "error";

  const checks: ChequeoDeCanal[] = [];

  // 1. El número. Es lo primero que el dueño quiere ver y lo que faltaba en coexistencia.
  if (pendingNumber) {
    checks.push({
      key: "numero",
      label: "Tu número está publicado en Meta",
      ok: false,
      detail: "Meta todavía no publica el número en tu cuenta de WhatsApp. Suele tardar unos minutos.",
      fix: "No tienes que hacer nada: esta pantalla se actualiza sola en cuanto llegue.",
    });
  } else if (displayPhone) {
    checks.push({ key: "numero", label: "Tu número está publicado en Meta", ok: true, detail: `${displayPhone}${e.graph?.verifiedName ? ` · ${e.graph.verifiedName}` : ""}` });
  } else {
    checks.push({
      key: "numero",
      label: "Tu número está publicado en Meta",
      ok: false,
      detail: "El canal no tiene un número asociado.",
      fix: "Vuelve a conectar tu WhatsApp desde esta página.",
    });
  }

  // 2. El acceso con Meta (token del canal).
  if (e.sinToken) {
    checks.push({
      key: "token",
      label: "El acceso con Meta está vigente",
      ok: false,
      detail: "Este canal no tiene su propio acceso de Meta cargado.",
      fix: "Vuelve a conectar tu WhatsApp para renovar el acceso.",
    });
  } else if (tokenVencido) {
    checks.push({
      key: "token",
      label: "El acceso con Meta está vigente",
      ok: false,
      detail: "El acceso con Meta venció o fue revocado, así que tu asistente no puede responder.",
      fix: "Vuelve a conectar tu WhatsApp para renovarlo.",
    });
  } else if (!e.graph) {
    checks.push({ key: "token", label: "El acceso con Meta está vigente", ok: false, unknown: true, detail: "No pudimos comprobarlo ahora." });
  } else if (!e.graph.ok) {
    checks.push({ key: "token", label: "El acceso con Meta está vigente", ok: false, unknown: true, detail: e.graph.error ?? "Meta no respondió." });
  } else {
    checks.push({ key: "token", label: "El acceso con Meta está vigente", ok: true, detail: "Conexión con Meta confirmada." });
  }

  // 3. El webhook: sin esto los mensajes llegan a Meta y nunca a nosotros. Es el fallo más
  //    difícil de ver desde afuera, porque la conexión "se ve" bien.
  if (!e.suscripcion || e.suscripcion.suscrita === null) {
    checks.push({ key: "webhook", label: "Meta nos avisa de tus mensajes", ok: false, unknown: true, detail: "No pudimos comprobarlo ahora." });
  } else if (!e.suscripcion.suscrita) {
    checks.push({
      key: "webhook",
      label: "Meta nos avisa de tus mensajes",
      ok: false,
      detail: "Meta no nos está avisando de los mensajes de este número, así que tu asistente no los ve.",
      fix: "Vuelve a conectar tu WhatsApp: la reconexión deja el aviso configurado.",
    });
  } else {
    const otras = e.suscripcion.otras.length ? ` · ⚠ otra app también está conectada (${e.suscripcion.otras.join(", ")}) y podría estar recibiendo los mensajes` : "";
    checks.push({ key: "webhook", label: "Meta nos avisa de tus mensajes", ok: true, detail: `Avisos activos${otras}` });
  }

  // 4. Quién atiende. Un canal sin asistente recibe mensajes y no contesta a nadie.
  if (e.defaultAgent) {
    checks.push({ key: "asistente", label: "Un asistente atiende este canal", ok: true, detail: `Atiende ${e.defaultAgent.name}` });
  } else {
    checks.push({
      key: "asistente",
      label: "Un asistente atiende este canal",
      ok: false,
      detail: "Nadie está asignado a este número, así que los mensajes llegan y quedan sin responder.",
      fix: "Asigna tu asistente desde esta misma pantalla.",
    });
  }

  // 5. Calidad del número (la que Meta usa para limitar los envíos).
  if (qualityRating === "RED") {
    checks.push({
      key: "calidad",
      label: "Calidad del número",
      ok: false,
      detail: "Meta bajó la calidad de tu número a roja: puede limitar cuántos mensajes envías.",
      fix: "Evita mensajes masivos no solicitados por unos días; la calidad se recupera sola.",
    });
  } else if (qualityRating === "YELLOW") {
    checks.push({ key: "calidad", label: "Calidad del número", ok: true, detail: "Amarilla: Meta la bajó un poco. Si sigue así puede limitar tus envíos." });
  } else if (qualityRating === "GREEN") {
    checks.push({ key: "calidad", label: "Calidad del número", ok: true, detail: "Verde" });
  } else {
    checks.push({ key: "calidad", label: "Calidad del número", ok: false, unknown: true, detail: "Meta aún no reporta la calidad de este número." });
  }

  // 6. Avisos de la cuenta de WhatsApp (restricciones, plantillas rechazadas, calidad).
  if (e.accountAlert) {
    checks.push({
      key: "cuenta",
      label: "Tu cuenta de WhatsApp no tiene avisos",
      ok: false,
      detail: `${e.accountAlert.message ?? e.accountAlert.type} (${cuando(e.accountAlert.at)})`,
      fix: "Si no sabes qué significa, pregúntale al asistente y lo revisamos contigo.",
    });
  } else {
    checks.push({ key: "cuenta", label: "Tu cuenta de WhatsApp no tiene avisos", ok: true, detail: "Sin avisos en los últimos 7 días" });
  }

  return {
    channelId: e.canal.id,
    channelType: e.canal.type,
    channelName: e.canal.name,
    displayPhone,
    verifiedName: e.graph?.verifiedName ?? null,
    qualityRating,
    mode,
    coexVerified,
    pendingNumber,
    wabaId: e.wabaId,
    channelStatus: e.canal.status,
    tokenHealthy,
    accountAlert: e.accountAlert,
    webhookSubscribed: e.suscripcion?.suscrita ?? null,
    defaultAgent: e.defaultAgent,
    lastInboundAt: e.lastInboundAt,
    lastOutboundAt: e.lastOutboundAt,
    checks,
  };
}

/** Resumen en una frase para Convi y para los avisos (sin tokens, sin jerga). */
export function resumirReporte(r: ReporteDeCanal): string {
  if (r.pendingNumber) return "Tu WhatsApp quedó conectado y Meta está publicando el número; suele tardar unos minutos.";
  const malos = r.checks.filter((c) => !c.ok && !c.unknown);
  if (!malos.length) return `Conectado y atendiendo: ${r.displayPhone ?? "tu número"}${r.defaultAgent ? ` · atiende ${r.defaultAgent.name}` : ""}.`;
  return `Conectado con ${malos.length === 1 ? "un punto pendiente" : `${malos.length} puntos pendientes`}: ${malos.map((c) => c.label.toLowerCase()).join("; ")}.`;
}
