import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_LEGACY_SCOPES,
  GOOGLE_SHEETS_SCOPES,
  canUseFeature,
  googleOAuthAppForBrand,
  googleOAuthAppOfConnection,
  googleOAuthCredentials,
  grantedScopes,
  hasConversiaGoogleApp,
  missingScopesForFeature,
  parseGrantedScopes,
  scopesForAuthorize,
  scopesForFeature,
} from "@conversia/config";

/**
 * ETAPA 0 (a) y (b) — permisos de Google por FUNCIÓN y app por MARCA.
 *
 * El bloque que más importa es el último: **las conexiones de Google que YA existen (TuBot)
 * tienen que seguir funcionando exactamente igual, sin reconectar nada.** No tienen `scopes`
 * ni `oauthApp` guardados, así que todo lo que se decida a partir de esos campos ausentes
 * tiene que caer del lado seguro.
 */

const SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
const CAL_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const CAL_READONLY = "https://www.googleapis.com/auth/calendar.readonly";

describe("permisos por función (autorización incremental)", () => {
  it("conectar Calendar NO pide planillas", () => {
    const pedidos = scopesForFeature("calendar");
    expect(pedidos).toEqual([CAL_EVENTS, CAL_READONLY]);
    expect(pedidos).not.toContain(SPREADSHEETS);
  });

  it("conectar Sheets pide SOLO planillas", () => {
    expect(scopesForFeature("sheets")).toEqual([SPREADSHEETS]);
  });

  it("los permisos viejos eran los tres juntos", () => {
    expect(GOOGLE_LEGACY_SCOPES).toEqual([...GOOGLE_CALENDAR_SCOPES, ...GOOGLE_SHEETS_SCOPES]);
  });

  it("parsea el campo `scope` que devuelve Google", () => {
    expect(parseGrantedScopes(`${CAL_EVENTS} ${CAL_READONLY}`)).toEqual([CAL_EVENTS, CAL_READONLY]);
    expect(parseGrantedScopes("  a   b  ")).toEqual(["a", "b"]);
    expect(parseGrantedScopes("")).toEqual([]);
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes(42)).toEqual([]);
  });
});

describe("app de Google por marca", () => {
  const conCreds = { GOOGLE_OAUTH_CLIENT_ID: "tb", GOOGLE_OAUTH_CLIENT_SECRET: "tbs", GOOGLE_OAUTH_CONVERSIA_CLIENT_ID: "cv", GOOGLE_OAUTH_CONVERSIA_CLIENT_SECRET: "cvs" };
  const sinCreds = { GOOGLE_OAUTH_CLIENT_ID: "tb", GOOGLE_OAUTH_CLIENT_SECRET: "tbs" };

  it("una org de Conversia usa la app de Conversia si está cargada", () => {
    expect(googleOAuthAppForBrand("conversia", conCreds)).toBe("conversia");
    expect(googleOAuthCredentials("conversia", conCreds).clientId).toBe("cv");
  });

  it("sin las credenciales de Conversia cargadas usa la de siempre (se despliega sin paso previo)", () => {
    expect(hasConversiaGoogleApp(sinCreds)).toBe(false);
    expect(googleOAuthAppForBrand("conversia", sinCreds)).toBe("default");
  });

  it("TuBot usa la de siempre aunque existan las de Conversia", () => {
    expect(googleOAuthAppForBrand("tubot", conCreds)).toBe("default");
    expect(googleOAuthCredentials("default", conCreds).clientId).toBe("tb");
  });

  it("marca ausente o desconocida = la de siempre", () => {
    expect(googleOAuthAppForBrand(null, conCreds)).toBe("default");
    expect(googleOAuthAppForBrand(undefined, conCreds)).toBe("default");
    expect(googleOAuthAppForBrand("otra", conCreds)).toBe("default");
  });

  it("avisa cuando las credenciales de la app elegida NO están cargadas", () => {
    expect(googleOAuthCredentials("conversia", sinCreds).missing).toBe(true);
    expect(googleOAuthCredentials("default", sinCreds).missing).toBe(false);
    expect(googleOAuthCredentials("default", {}).missing).toBe(true);
  });
});

describe("con qué app se refresca un token YA emitido", () => {
  it("la que diga la conexión", () => {
    expect(googleOAuthAppOfConnection({ oauthApp: "conversia" })).toBe("conversia");
    expect(googleOAuthAppOfConnection({ oauthApp: "default" })).toBe("default");
  });

  it("una conexión SIN oauthApp se refresca con la app de siempre, no con la de su marca", () => {
    // Es la línea que evita romper lo que ya está andando: ese token lo emitió la única app
    // que existía. Resolver por marca haría que una org Conversia conectada antes de este
    // cambio se refresque con credenciales que no emitieron su token → invalid_grant.
    expect(googleOAuthAppOfConnection({ calendarId: "x@gmail.com", calendarSync: true })).toBe("default");
    expect(googleOAuthAppOfConnection({})).toBe("default");
    expect(googleOAuthAppOfConnection(null)).toBe("default");
    expect(googleOAuthAppOfConnection(undefined)).toBe("default");
  });

  it("un valor basura no se cuela como app", () => {
    expect(googleOAuthAppOfConnection({ oauthApp: "pirata" })).toBe("default");
    expect(googleOAuthAppOfConnection({ oauthApp: 7 })).toBe("default");
  });
});

describe("REGRESIÓN TuBot — las conexiones que ya existen siguen igual, sin reconectar", () => {
  /** Config real de una cuenta de TuBot con el espejo andando: ni `scopes` ni `oauthApp`. */
  const vieja = { accountEmail: "clinica@gmail.com", calendarId: "clinica@gmail.com", calendarSync: true };

  it("se le asumen los 3 permisos que siempre se pidieron", () => {
    expect(grantedScopes(vieja)).toEqual(GOOGLE_LEGACY_SCOPES);
  });

  it("puede seguir usando Calendar Y Sheets sin avisos de reconexión", () => {
    expect(canUseFeature(vieja, "calendar")).toBe(true);
    expect(canUseFeature(vieja, "sheets")).toBe(true);
    expect(missingScopesForFeature(vieja, "calendar")).toEqual([]);
    expect(missingScopesForFeature(vieja, "sheets")).toEqual([]);
  });

  it("conserva su calendarId y su espejo: nada de la config vieja se reinterpreta", () => {
    expect(vieja.calendarId).toBe("clinica@gmail.com");
    expect(vieja.calendarSync).toBe(true);
  });

  /**
   * El drawer de Google de TuBot (`apps/web`) es UNA tarjeta para Calendar **y** Sheets, y
   * llama a `authorize` SIN declarar función. Si eso cae al default `calendar`, un tenant de
   * TuBot que conecte de cero obtiene Calendar y NO `spreadsheets`, y desde su panel no tiene
   * ninguna forma de pedirlo: el paso "Añadir fila a Google Sheets" de Workflows queda muerto.
   *
   * Alcanzable hoy con el botón "Desconectar" del propio drawer: borra la conexión, así que
   * `include_granted_scopes` ya no tiene nada que conservar.
   *
   * Por eso "no declaró función" ≠ "calendar": significa los permisos de siempre.
   */
  it("pedir permisos SIN declarar función pide los 3 de siempre (el drawer de TuBot)", () => {
    expect(scopesForAuthorize(undefined)).toEqual(GOOGLE_LEGACY_SCOPES);
    expect(scopesForAuthorize(null)).toEqual(GOOGLE_LEGACY_SCOPES);
    expect(scopesForAuthorize("")).toEqual(GOOGLE_LEGACY_SCOPES);
    expect(scopesForAuthorize("   ")).toEqual(GOOGLE_LEGACY_SCOPES);
    expect(scopesForAuthorize(undefined)).toContain(SPREADSHEETS);
  });

  it("declarar función sigue pidiendo SOLO lo de esa función (Conversia no ve planillas)", () => {
    expect(scopesForAuthorize("calendar")).toEqual([CAL_EVENTS, CAL_READONLY]);
    expect(scopesForAuthorize("calendar")).not.toContain(SPREADSHEETS);
    expect(scopesForAuthorize("sheets")).toEqual([SPREADSHEETS]);
    expect(scopesForAuthorize(" calendar ")).toEqual([CAL_EVENTS, CAL_READONLY]);
  });

  it("una función inventada NO se degrada a los 3 permisos: se rechaza", () => {
    // Degradar sería peor que fallar: un `?feature=calendario` mal escrito pediría
    // planillas sin que nadie lo pida.
    expect(() => scopesForAuthorize("planillas")).toThrow();
    expect(() => scopesForAuthorize("CALENDAR")).toThrow();
  });
});

describe("conexiones nuevas: qué puede hacer cada una", () => {
  const soloCalendar = { scopes: [CAL_EVENTS, CAL_READONLY], oauthApp: "conversia" };
  const calendarYSheets = { scopes: [CAL_EVENTS, CAL_READONLY, SPREADSHEETS] };

  it("una conexión de solo Calendar no puede Sheets y dice qué le falta", () => {
    expect(canUseFeature(soloCalendar, "calendar")).toBe(true);
    expect(canUseFeature(soloCalendar, "sheets")).toBe(false);
    expect(missingScopesForFeature(soloCalendar, "sheets")).toEqual([SPREADSHEETS]);
  });

  it("tras sumar Sheets puede las dos cosas", () => {
    expect(canUseFeature(calendarYSheets, "calendar")).toBe(true);
    expect(canUseFeature(calendarYSheets, "sheets")).toBe(true);
  });

  it("si el cliente desmarca un permiso en la pantalla de Google, se refleja", () => {
    // Google devuelve en `scope` lo OTORGADO, no lo pedido. Guardar lo pedido (lo que hacía
    // el código) dejaba al panel afirmando un permiso que no existía.
    const aMedias = { scopes: [CAL_READONLY] };
    expect(canUseFeature(aMedias, "calendar")).toBe(false);
    expect(missingScopesForFeature(aMedias, "calendar")).toEqual([CAL_EVENTS]);
  });

  it("una lista VACÍA cuenta como 'no se sabe' y cae a los permisos históricos", () => {
    // `scopes: []` solo pasa si Google no devolvió el campo `scope`. Elegimos la suposición
    // heredada —los 3 de siempre— y NO "sin permisos": lo segundo apagaría una integración
    // que está funcionando por un dato que no vino. El riesgo de afirmar un permiso de más
    // lo cubre el mensaje claro del 403 en `google-sheets.ts`.
    expect(grantedScopes({ scopes: [] })).toEqual(GOOGLE_LEGACY_SCOPES);
    expect(grantedScopes({})).toEqual(GOOGLE_LEGACY_SCOPES);
  });
});
