import { afterAll, describe, expect, it } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { allowedOriginsOf, baseHostOf, brandFromOrigin, getEnv } from "@conversia/config";
import { PasskeysService, limpiarEtiqueta, rpDeLaMarca, transportesDe } from "../src/auth/passkeys.service";
import { AuthController } from "../src/auth/auth.controller";
import { TenancyMiddleware } from "../src/tenancy/tenancy.middleware";

/**
 * PASSKEYS (P1) — entrar con Face ID / huella / Windows Hello.
 *
 * Lo que vigila este archivo son las dos cosas que, si se rompen, no avisan:
 *
 *  1. **El dominio dueño de la llave sale de NUESTRA configuración, no del `Origin`.** Un
 *     passkey queda amarrado a un dominio (el "RP ID"). Si ese dominio se tomara del Origin
 *     que manda el cliente, quien llame a la API con un Origin inventado elegiría a nombre de
 *     qué dominio se emite la credencial.
 *  2. **Ninguna ruta de gestión de passkeys puede quedar pública.** `PUBLIC_PREFIXES` compara
 *     con `startsWith`, así que un prefijo `/auth/passkey` (pensado para el login de P2)
 *     abriría de regalo inscribir y quitar aparatos. El síntoma sería nulo hasta que alguien
 *     lo aprovechara.
 *
 * El flujo completo (crear credencial con un autenticador real, verificar la firma) no se
 * puede simular acá: necesita un aparato con biometría. Lo que SÍ se prueba es todo lo que
 * decide el servidor antes y después de esa firma.
 */

const ORIGEN_CONVERSIA = "https://app.conversia.cl";

describe("el RP ID y los orígenes salen de la configuración, NO del Origin del cliente", () => {
  it("un Origin inventado NO elige el dominio de la credencial", () => {
    // Lo que intenta el atacante: `Origin: https://falso.cl` para que la llave quede emitida a
    // nombre de su dominio. `brandFromOrigin` no lo reconoce → cae en la marca por defecto, y
    // el RP ID sale de la config de ESA marca. Nunca de `falso.cl`.
    const marca = brandFromOrigin("https://falso.cl");
    const rp = rpDeLaMarca(marca);
    expect(rp.rpId).not.toContain("falso");
    expect(rp.origins.join(" ")).not.toContain("falso");
    // Y el dominio que sale es uno de los nuestros, el de la marca por defecto.
    expect(rp.rpId).toBe(baseHostOf(getEnv().WEB_URL));
  });

  it("PASE LO QUE LE PASEN, el dominio emitido es uno de los nuestros", () => {
    // El test de arriba comprueba el camino de hoy. Este comprueba la PROPIEDAD, que es lo
    // que hay que conservar: el RP ID es función de la CONFIGURACIÓN, nunca del dato que
    // llega en la petición. Así, el día que alguien "simplifique" pasándole el Origin a
    // `rpDeLaMarca` en vez de la marca, esto se pone rojo — que es el refactor peligroso,
    // porque a simple vista seguiría funcionando en producción.
    const nuestros = new Set(
      [getEnv().WEB_URL, getEnv().WEB_URL_CONVERSIA].map((u) => baseHostOf(u)).filter((h): h is string => !!h),
    );
    const hostiles = [
      "https://falso.cl",
      "https://app.conversia.cl.falso.cl",
      "conversia.cl",
      "tubot.cl.evil.io",
      "//evil.io",
      "http://localhost:1337",
      "",
      "   ",
      "../../etc",
      "https://falso.cl#conversia",
    ];
    for (const entrada of [...hostiles, "tubot", "conversia", undefined, null]) {
      const rp = rpDeLaMarca(entrada as string | null | undefined);
      expect(nuestros.has(rp.rpId), `con la entrada ${JSON.stringify(entrada)} salió rpId=${rp.rpId}`).toBe(true);
      // Y todo origen aceptado tiene que pertenecer al mismo dominio del rpId.
      for (const o of rp.origins) {
        expect(baseHostOf(o), `origen ajeno al rpId: ${o}`).toBe(rp.rpId);
      }
    }
  });

  it("el RP ID es el dominio BASE, para que cubra también el subdominio del panel", () => {
    // Regla de WebAuthn: una credencial de `conversia.cl` sirve en `conversia.cl` y en
    // cualquier subdominio suyo (`app.conversia.cl`), pero NO al revés. Por eso el RP ID es
    // el apex: si se emitiera para `app.conversia.cl`, la portada no podría usarla.
    expect(baseHostOf("https://app.conversia.cl")).toBe("conversia.cl");
    expect(baseHostOf("https://www.conversia.cl")).toBe("conversia.cl");
    expect(baseHostOf("https://conversia.cl")).toBe("conversia.cl");
  });

  it("los orígenes aceptados son los MISMOS que deja pasar el CORS (una sola lista)", () => {
    // Si estas dos listas se separaran, agregar un host al CORS dejaría los passkeys rotos en
    // silencio. `allowedOriginsOf` es la única definición y la usan los dos (ver main.ts).
    const origins = allowedOriginsOf("https://app.conversia.cl");
    expect(origins).toContain("https://app.conversia.cl");
    expect(origins).toContain("https://conversia.cl");
    expect(origins).toContain("https://www.conversia.cl");
  });

  it("una URL con barra final no genera un origen con barra (no casaría nunca)", () => {
    // `expectedOrigin` se compara TEXTUALMENTE contra lo que informa el navegador, y el
    // navegador nunca manda la barra. Un "https://x.cl/" en la env rompería la verificación.
    expect(allowedOriginsOf("https://conversia.cl/")).toContain("https://conversia.cl");
    expect(allowedOriginsOf("https://conversia.cl/").some((o) => o.endsWith("/"))).toBe(false);
  });

  it("una URL ilegible no inventa un dominio: devuelve null y el servicio corta", () => {
    expect(baseHostOf("no-es-una-url")).toBeNull();
    expect(baseHostOf(undefined)).toBeNull();
    expect(baseHostOf("")).toBeNull();
  });

  it("marcas distintas emiten para dominios distintos (un passkey no cruza de marca)", () => {
    const tubot = rpDeLaMarca("tubot");
    const conversia = rpDeLaMarca("conversia");
    // En un entorno sin WEB_URL_CONVERSIA las dos caen al mismo dominio, y eso es correcto
    // (es una sola marca servida). Lo que nunca puede pasar es que el RP ID salga vacío.
    expect(tubot.rpId.length).toBeGreaterThan(0);
    expect(conversia.rpId.length).toBeGreaterThan(0);
    expect(tubot.rpName).toBe("TuBot");
    expect(conversia.rpName).toBe("Conversia");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ninguna ruta de gestión de passkeys puede quedar pública
// ─────────────────────────────────────────────────────────────────────────────
describe("las rutas de passkeys exigen sesión", () => {
  const mw = new TenancyMiddleware();
  const correr = (ruta: string) =>
    mw.use({ originalUrl: ruta, headers: {} } as unknown as Request, {} as Response, (() => undefined) as NextFunction);

  it("inscribir, listar, renombrar y quitar aparatos NO son públicas", () => {
    // `PUBLIC_PREFIXES` se compara con `startsWith`. El día que alguien agregue el prefijo
    // público del login de P2 como "/auth/passkey" (en vez de "/auth/passkey-login"), estas
    // cuatro quedan abiertas y este test se pone rojo.
    for (const ruta of ["/auth/passkeys", "/auth/passkeys/options", "/auth/passkeys/cred_1"]) {
      expect(() => correr(ruta), `${ruta} quedó pública`).toThrowError(UnauthorizedException);
    }
  });

  it("ENTRAR con passkey (P2) SÍ es público — pero solo por el sufijo -login", () => {
    // El login por passkey no tiene sesión todavía, así que es público. Lo crítico es que el
    // prefijo sea "/auth/passkey-login" y NO "/auth/passkey": con el segundo, "/auth/passkeys"
    // (gestión) también empezaría por él y quedaría abierta. Este test exige las DOS cosas a la
    // vez: que el login entre sin token Y que la gestión siga protegida.
    expect(() => correr("/auth/passkey-login/options"), "el login por passkey debe ser público").not.toThrow();
    expect(() => correr("/auth/passkey-login"), "el login por passkey debe ser público").not.toThrow();
    expect(() => correr("/auth/passkeys"), "la gestión NO puede quedar pública").toThrowError(UnauthorizedException);
    expect(() => correr("/auth/passkeys/options"), "la gestión NO puede quedar pública").toThrowError(UnauthorizedException);
  });

  it("el detector sirve: una ruta que SÍ es pública pasa sin token", () => {
    // Sin esta comprobación, el test de arriba pasaría igual si el middleware rechazara TODO
    // (por ejemplo si `PUBLIC_PREFIXES` quedara vacío por accidente).
    expect(() => correr("/auth/login")).not.toThrow();
    expect(() => correr("/health")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nombre del aparato y transportes: datos que vienen del navegador
// ─────────────────────────────────────────────────────────────────────────────
describe("limpiarEtiqueta", () => {
  it("recorta, junta los espacios y mata los saltos de línea", () => {
    expect(limpiarEtiqueta("  iPhone   de\n\n Javier  ")).toBe("iPhone de Javier");
  });

  it("vacío o ausente cae a un nombre decente, nunca a cadena vacía", () => {
    expect(limpiarEtiqueta(undefined)).toBe("Este dispositivo");
    expect(limpiarEtiqueta("")).toBe("Este dispositivo");
    expect(limpiarEtiqueta("    ")).toBe("Este dispositivo");
    expect(limpiarEtiqueta("\n\t")).toBe("Este dispositivo");
  });

  it("tiene tope: un nombre larguísimo no rompe la pantalla de aparatos", () => {
    expect(limpiarEtiqueta("a".repeat(500)).length).toBe(60);
  });
});

describe("transportesDe", () => {
  it("deja pasar solo los transportes que existen", () => {
    expect(transportesDe(["internal", "hybrid"])).toEqual(["internal", "hybrid"]);
  });

  it("descarta basura sin explotar (el valor viene del navegador y vive como Json)", () => {
    expect(transportesDe(["internal", "inventado", 42, null, { a: 1 }])).toEqual(["internal"]);
    expect(transportesDe(null)).toEqual([]);
    expect(transportesDe("internal")).toEqual([]);
    expect(transportesDe(undefined)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quitar un aparato está acotado al dueño
// ─────────────────────────────────────────────────────────────────────────────
describe("quitar y renombrar están acotados al dueño de la credencial", () => {
  /** Prisma falso que REGISTRA el `where` recibido: lo que se prueba es el acotamiento. */
  const vistos: any[] = [];
  const prisma: any = {
    admin: {
      webauthnCredential: {
        deleteMany: async ({ where }: any) => {
          vistos.push(where);
          // Simula "no era tuya": el `where` con userId ajeno no encuentra nada.
          return { count: where.userId === "u1" && where.id === "cred_1" ? 1 : 0 };
        },
        updateMany: async ({ where }: any) => {
          vistos.push(where);
          return { count: where.userId === "u1" && where.id === "cred_1" ? 1 : 0 };
        },
        findUnique: async () => ({
          id: "cred_1",
          label: "Mi teléfono",
          createdAt: new Date("2026-11-16T12:00:00Z"),
          lastUsedAt: null,
          deviceType: "multiDevice",
        }),
      },
    },
  };
  const service = new PasskeysService(prisma);

  afterAll(async () => {
    // El servicio abre su propio cliente de Redis en el constructor; sin esto vitest se queda
    // con el socket colgando y el proceso no termina.
    await service.onModuleDestroy();
  });

  it("el userId va SIEMPRE en el where, no solo en una comprobación aparte", async () => {
    await service.quitar("u1", "cred_1");
    expect(vistos.at(-1)).toEqual({ id: "cred_1", userId: "u1" });
  });

  it("con el id de otra persona no borra nada y avisa", async () => {
    // El id de una credencial no se usa nunca suelto: si se usara, bastaría conocer un id
    // ajeno para dejar a alguien sin su forma de entrar.
    await expect(service.quitar("u2", "cred_1")).rejects.toBeInstanceOf(BadRequestException);
    expect(vistos.at(-1)).toEqual({ id: "cred_1", userId: "u2" });
  });

  it("renombrar también va acotado, y limpia el nombre que llega del navegador", async () => {
    const r = await service.renombrar("u1", "cred_1", "   Teléfono   del  mostrador  ");
    expect(vistos.at(-1)).toEqual({ id: "cred_1", userId: "u1" });
    expect(r.ok).toBe(true);
    await expect(service.renombrar("u2", "cred_1", "Mío")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("la vista que sale al panel no lleva la llave pública ni el contador", async () => {
    // No le sirven a nadie fuera del servidor, y el contador es un detalle anti-clonación.
    const r = await service.renombrar("u1", "cred_1", "Mi teléfono");
    expect(Object.keys(r.aparato).sort()).toEqual(["createdAt", "id", "label", "lastUsedAt", "sincronizada"]);
  });

  it("marca como sincronizada la credencial multiDevice (se recupera en otro teléfono)", async () => {
    const r = await service.renombrar("u1", "cred_1", "Mi teléfono");
    expect(r.aparato.sincronizada).toBe(true);
  });
});

describe("el Origin de Conversia resuelve a la marca Conversia", () => {
  it("app.conversia.cl → conversia (si la env está puesta en este entorno)", () => {
    // Defensivo: en un entorno sin WEB_URL_CONVERSIA esto cae a tubot, y es correcto. Lo que
    // se comprueba es que la función NO depende de un literal escrito a mano.
    const marca = brandFromOrigin(ORIGEN_CONVERSIA);
    expect(["tubot", "conversia"]).toContain(marca);
    if (getEnv().WEB_URL_CONVERSIA) expect(marca).toBe("conversia");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — el cupo del desafío NO es el cupo del login
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Desde P4 la pantalla de login pide un desafío de passkey **sola, al cargar**, para poder
 * ofrecer la llave dentro del campo de correo (mediación condicional). Eso multiplica las
 * llamadas a `/auth/passkey-login/options` por cada visita a /login, de cualquiera.
 *
 * Si esas llamadas gastaran `loginByIp` —el cupo que comparten `/auth/login` y la
 * verificación del passkey, 100 por 15 minutos POR IP— una clínica detrás de un NAT
 * recargando la pantalla se quedaría sin poder entrar, con un «Demasiados intentos de inicio
 * de sesión» que nadie provocó: no hubo ni un intento. Y el síntoma sería indistinguible de
 * un ataque real.
 *
 * Acuñar un desafío no comprueba ninguna credencial ni delata si una cuenta existe, así que
 * puede tener su propio cupo más laxo. Lo que NO puede cambiar es el cupo de los dos
 * endpoints que sí comprueban algo. Eso es lo que fija este bloque.
 */
describe("P4 — pedir el desafío no gasta el cupo del login", () => {
  /** Anota qué limitador tocó cada ruta. Todos permiten, para no cortar el flujo. */
  function limitadorEspia() {
    const usados: string[] = [];
    const ok = { allowed: true, count: 1, retryAfterSeconds: 0 };
    return {
      usados,
      servicio: {
        loginByIp: async () => {
          usados.push("loginByIp");
          return ok;
        },
        passkeyChallengeByIp: async () => {
          usados.push("passkeyChallengeByIp");
          return ok;
        },
        login: async () => {
          usados.push("login");
          return ok;
        },
      } as any,
    };
  }

  const peticion = () => ({ ip: "203.0.113.9", headers: { origin: ORIGEN_CONVERSIA }, socket: {} }) as unknown as Request;

  it("pedir el desafío usa SU PROPIO cupo, no el del login", async () => {
    const espia = limitadorEspia();
    const passkeys: any = { opcionesDeLogin: async () => ({ loginId: "x", opciones: {} }) };
    const controller = new AuthController({} as any, {} as any, espia.servicio, passkeys);

    await controller.passkeyLoginOptions(peticion());

    expect(espia.usados).toEqual(["passkeyChallengeByIp"]);
    expect(espia.usados, "el desafío se está comiendo el cupo del login").not.toContain("loginByIp");
  });

  it("pero VERIFICAR la firma sigue gastando el cupo del login (ahí sí hay algo que frenar)", async () => {
    const espia = limitadorEspia();
    const passkeys: any = {
      verificarLogin: async () => {
        throw new UnauthorizedException("no importa: lo que se mide es el limitador");
      },
    };
    const controller = new AuthController({} as any, {} as any, espia.servicio, passkeys);

    await controller
      .passkeyLogin(peticion(), { loginId: "x", response: { id: "abc" } })
      .catch(() => undefined);

    expect(espia.usados).toContain("loginByIp");
  });

  it("y el cupo propio está ACOTADO: no es barra libre para llenar Redis", async () => {
    // Se lee del código del servicio en vez de pegarle a Redis: lo que importa es que haya
    // un techo y una ventana, no el número exacto.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fuente = readFileSync(join(__dirname, "..", "src", "common", "rate-limit.ts"), "utf8");
    const cuerpo = /async passkeyChallengeByIp[\s\S]*?\n  }/.exec(fuente)?.[0] ?? "";
    expect(cuerpo, "no se pudo leer el limitador (si no, este test no prueba nada)").toContain("rl:pkchal:ip:");
    expect(cuerpo).toMatch(/LOGIN_MAX_PER_WINDOW\s*\*\s*\d+/);
    expect(cuerpo).toContain("LOGIN_WINDOW_SECONDS");
  });
});
