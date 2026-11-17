import { BadRequestException, Injectable, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { getEnv, allowedOriginsOf, baseHostOf, brandOf } from "@conversia/config";
import { PrismaService } from "../prisma.service";

/**
 * PASSKEYS (WebAuthn) — P1: inscribir, listar y quitar aparatos. P2: ENTRAR con el passkey
 * (autenticación), ver `opcionesDeLogin` / `verificarLogin` más abajo.
 *
 * Qué es un passkey, en una línea: una llave privada que vive en el chip seguro del aparato y
 * que la biometría solo DESTRABA. Acá se guarda nada más que la llave pública, así que no hay
 * ningún dato biométrico en la base ni viajando por la red.
 *
 * Lo que este archivo NO hace todavía: sostener una sesión sin techo de 24 h en el móvil (P3).
 * Ver `docs/PROMPT_PASSKEYS_BIOMETRIA.md`.
 */

/** Cuánto vive un desafío sin usarse. Corto a propósito: es de un solo uso y de un solo rato. */
const DESAFIO_TTL_SEG = 300;

/** Tope del nombre que la persona le pone a un aparato. Es texto decorativo, pero acotado. */
export const LARGO_MAX_ETIQUETA = 60;

/**
 * El RP (Relying Party) de una marca: QUIÉN es el dueño de la llave.
 *
 * **El dato clave de seguridad de todo este módulo.** Ni el `rpId` ni los orígenes salen del
 * `Origin` que manda el cliente. El Origin solo sirve para ELEGIR la marca (con
 * `brandFromOrigin`, que ya estaba probado); el dominio con el que se firma la llave y contra
 * el que se verifica sale de NUESTRA configuración (`WEB_URL` / `WEB_URL_CONVERSIA`).
 *
 * Por qué importa: si el `rpId` se tomara del Origin crudo, quien llame a la API con un
 * `Origin: https://falso.cl` inventado estaría eligiendo el dominio dueño de la credencial.
 * Tal como está, un Origin inventado cae en la marca por defecto y recibe nuestro dominio
 * real — que no le sirve de nada.
 */
export interface RpDeLaMarca {
  /** Dominio dueño de la llave. `conversia.cl` cubre también `app.conversia.cl` (subdominio). */
  rpId: string;
  /** Nombre que el teléfono le muestra a la persona al pedirle la cara o el dedo. */
  rpName: string;
  /** Orígenes aceptables al verificar. Misma lista que el CORS de la api (una sola fuente). */
  origins: string[];
}

export function rpDeLaMarca(brand: string | null | undefined): RpDeLaMarca {
  // `brandOf` es el único camino permitido para resolver una marca en este repo (ver el
  // encabezado de brands.ts): ya trae el nombre visible y la URL del panel con su fallback.
  const marca = brandOf({ brand });
  const rpId = baseHostOf(marca.webUrl);
  // Sin un dominio legible no se puede emitir una credencial: devolver algo inventado la
  // ataría a un dominio que no es nuestro y no serviría nunca. Es un error de configuración.
  if (!rpId) throw new ServiceUnavailableException("El dominio del panel no está bien configurado.");
  return { rpId, rpName: marca.name, origins: allowedOriginsOf(marca.webUrl) };
}

/** Una credencial tal como la ve la persona en «Aparatos con acceso». */
export interface AparatoConAcceso {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** `true` si la llave se sincroniza (iCloud / Google) → un teléfono nuevo la recupera. */
  sincronizada: boolean;
  /** `true` si es la credencial con la que se entró en esta sesión (P2 la va a usar). */
  esteAparato?: boolean;
}

@Injectable()
export class PasskeysService implements OnModuleDestroy {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });

  constructor(private prisma: PrismaService) {
    this.redis.on("error", () => undefined);
    void this.redis.connect().catch(() => undefined);
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  private claveDesafio(proposito: "reg" | "auth", quien: string, rpId: string) {
    return `pkch:${proposito}:${rpId}:${quien}`;
  }

  /**
   * Guarda el desafío. **Fail-CLOSED**: si Redis no está, la inscripción se corta acá.
   *
   * Al revés del login (que es fail-open al crear la sesión), acá no hay nada que salvar: sin
   * desafío guardado no habría contra qué verificar la respuesta del aparato, y el único
   * camino sería aceptarla sin comprobarla. Mejor un error claro que una credencial inscrita
   * sin verificar de verdad.
   */
  private async guardarDesafio(clave: string, desafio: string): Promise<void> {
    try {
      await this.redis.set(clave, desafio, "EX", DESAFIO_TTL_SEG);
    } catch {
      throw new ServiceUnavailableException("No se pudo preparar el registro del aparato. Intenta de nuevo en un momento.");
    }
  }

  /**
   * Consume el desafío: lo lee y lo BORRA en la misma operación (`GETDEL`), para que una
   * respuesta capturada no se pueda reenviar. Fail-closed: sin desafío, no se verifica nada.
   */
  private async consumirDesafio(clave: string): Promise<string> {
    let guardado: string | null = null;
    try {
      guardado = await this.redis.getdel(clave);
    } catch {
      throw new ServiceUnavailableException("No se pudo validar el registro del aparato. Intenta de nuevo.");
    }
    if (!guardado) throw new BadRequestException("El registro del aparato venció o ya se usó. Vuelve a intentarlo.");
    return guardado;
  }

  /** Las credenciales de un usuario EN ESTA MARCA (un passkey de tubot.cl no sirve acá). */
  private async credencialesDe(userId: string, rpId: string) {
    return this.prisma.admin.webauthnCredential.findMany({
      where: { userId, rpId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Paso 1 de inscribir un aparato: el desafío y las opciones que el navegador le pasa a
   * `navigator.credentials.create()`.
   */
  async opcionesDeRegistro(userId: string, brand: string | null | undefined) {
    const rp = rpDeLaMarca(brand);
    const user = await this.prisma.admin.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new UnauthorizedException("No autenticado");

    const yaInscritas = await this.credencialesDe(userId, rp.rpId);

    const opciones = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpId,
      userName: user.email,
      userDisplayName: user.name,
      // El `userID` es el id INTERNO, nunca el correo: este valor queda guardado dentro del
      // autenticador del aparato, y el correo no tiene por qué vivir ahí.
      userID: new Uint8Array(Buffer.from(user.id, "utf8")),
      attestationType: "none",
      // Para que el mismo aparato no quede inscrito dos veces: si la persona vuelve a apretar
      // "activar", el teléfono le dice "ya está registrado" en vez de crear un duplicado.
      excludeCredentials: yaInscritas.map((c) => ({
        id: c.credentialId,
        transports: transportesDe(c.transports),
      })),
      authenticatorSelection: {
        // `required`: la credencial queda DESCUBRIBLE, que es lo que permitirá en P2 entrar sin
        // teclear el correo (el teléfono sabe a qué cuenta pertenece).
        residentKey: "required",
        // `required` es la pieza que hace que esto sea "entrar con Face ID" y no "entrar con
        // una llave que está en el teléfono": sin verificación de la persona, bastaría tener
        // el aparato. Se escribe explícito aunque la librería ya lo traiga por defecto.
        userVerification: "required",
        // `authenticatorAttachment` queda SIN fijar a propósito. Ponerlo en "platform" ataría
        // la cuenta al aparato de turno y apagaría el flujo de "usar mi teléfono para entrar
        // en el computador" (QR), que es útil y sale gratis. En un teléfono, el autenticador
        // del propio aparato es igual la opción que el sistema ofrece primero.
      },
      // Pista (no restricción) para que el navegador arranque ofreciendo el aparato que la
      // persona tiene en la mano. Los navegadores que no la entienden la ignoran.
      preferredAuthenticatorType: "localDevice",
    });

    await this.guardarDesafio(this.claveDesafio("reg", userId, rp.rpId), opciones.challenge);
    return opciones;
  }

  /**
   * Paso 2: verifica lo que devolvió el aparato y guarda la llave pública.
   *
   * `response` llega del navegador y es dato NO confiable: lo único que decide si vale es la
   * verificación criptográfica contra el desafío que guardamos nosotros.
   */
  async confirmarRegistro(userId: string, brand: string | null | undefined, response: unknown, etiqueta: string | undefined) {
    const rp = rpDeLaMarca(brand);
    const desafio = await this.consumirDesafio(this.claveDesafio("reg", userId, rp.rpId));

    let verificacion: VerifiedRegistrationResponse;
    try {
      verificacion = await verifyRegistrationResponse({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lo valida la librería
        response: response as any,
        expectedChallenge: desafio,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpId,
        // Explícito, aunque sea el default: es la garantía de que hubo cara, dedo o PIN. Si una
        // versión futura cambiara ese default, acá no cambia nada.
        requireUserVerification: true,
      });
    } catch (e) {
      // La librería tira para todo lo que no cuadre (firma, origen, rpId, desafío). Para quien
      // está mirando la pantalla es siempre lo mismo: no se pudo registrar.
      throw new BadRequestException(`No se pudo registrar este aparato: ${(e as Error).message}`);
    }
    if (!verificacion.verified || !verificacion.registrationInfo) {
      throw new BadRequestException("No se pudo registrar este aparato.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verificacion.registrationInfo;
    const label = limpiarEtiqueta(etiqueta);

    // `credentialId` es único a nivel global: si esta credencial ya existe (de esta cuenta o de
    // otra) la escritura falla, y eso es lo correcto. No se "actualiza" la fila existente,
    // porque reasignar una credencial a otro usuario es justo lo que no debe poder pasar.
    const yaExiste = await this.prisma.admin.webauthnCredential.findUnique({
      where: { credentialId: credential.id },
      select: { userId: true },
    });
    if (yaExiste) {
      throw new BadRequestException(
        yaExiste.userId === userId
          ? "Este aparato ya estaba registrado."
          : "Esta llave ya está registrada en otra cuenta.",
      );
    }

    const creada = await this.prisma.admin.webauthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        rpId: rp.rpId,
        counter: credential.counter,
        transports: (credential.transports ?? []) as object,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        label,
      },
    });
    return { ok: true as const, aparato: aVista(creada) };
  }

  /** «Aparatos con acceso»: lo que la persona ve y puede quitar. */
  async listar(userId: string, brand: string | null | undefined): Promise<{ aparatos: AparatoConAcceso[] }> {
    const rp = rpDeLaMarca(brand);
    const filas = await this.credencialesDe(userId, rp.rpId);
    return { aparatos: filas.map(aVista) };
  }

  /**
   * Quita un aparato. Acotado por `userId` en el propio `where`: así nadie puede borrar el
   * aparato de otra persona pasando un id ajeno (el id no se usa nunca suelto).
   */
  async quitar(userId: string, id: string): Promise<{ ok: true; quitados: number }> {
    const r = await this.prisma.admin.webauthnCredential.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw new BadRequestException("Ese aparato no está en tu lista.");
    return { ok: true as const, quitados: r.count };
  }

  /** Renombra un aparato. Mismo acotamiento por `userId` que `quitar`. */
  async renombrar(userId: string, id: string, etiqueta: string): Promise<{ ok: true; aparato: AparatoConAcceso }> {
    const r = await this.prisma.admin.webauthnCredential.updateMany({
      where: { id, userId },
      data: { label: limpiarEtiqueta(etiqueta) },
    });
    if (r.count === 0) throw new BadRequestException("Ese aparato no está en tu lista.");
    const fila = await this.prisma.admin.webauthnCredential.findUnique({ where: { id } });
    return { ok: true as const, aparato: aVista(fila!) };
  }

  // ----------------------------- P2: ENTRAR con el passkey -----------------------------
  //
  // Paso 1: el servidor arma un desafío de AUTENTICACIÓN (no de registro). No se sabe todavía
  // QUIÉN está entrando —ese es justo el punto de un passkey descubrible: el teléfono elige la
  // cuenta—, así que el desafío se guarda bajo un `loginId` aleatorio que el cliente nos
  // devuelve al verificar. `userVerification: "required"` obliga a cara/dedo/PIN: eso es lo que
  // hace que entrar con el passkey sea DOS factores (posesión del aparato + verificación de la
  // persona), y por eso este login no pide además un código TOTP.
  async opcionesDeLogin(brand: string | null | undefined): Promise<{ loginId: string; opciones: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
    const rp = rpDeLaMarca(brand);
    const opciones = await generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: "required",
      // `allowCredentials` vacío = credencial DESCUBRIBLE: el aparato ofrece las cuentas que
      // tiene para este dominio sin que tecleemos el correo (para eso P1 inscribió con
      // `residentKey: "required"`).
      allowCredentials: [],
    });
    const loginId = randomUUID();
    await this.guardarDesafio(this.claveDesafio("auth", loginId, rp.rpId), opciones.challenge);
    return { loginId, opciones };
  }

  /**
   * Paso 2: verifica la firma del aparato y, si cuadra, devuelve el `userId` dueño de la
   * credencial para que el controller emita la sesión (con el MISMO emisor que el login por
   * contraseña). `response` es dato NO confiable: lo único que decide es la verificación
   * criptográfica contra el desafío que guardamos nosotros.
   *
   * Un passkey pertenece a UNA marca (su `rpId`): una llave de conversia.cl no entra en
   * tubot.cl ni al revés. Se exige explícitamente antes de verificar; además la propia
   * verificación fallaría por el `expectedRPID`.
   */
  async verificarLogin(
    brand: string | null | undefined,
    response: unknown,
    loginId: string,
  ): Promise<{ userId: string }> {
    const rp = rpDeLaMarca(brand);
    if (!loginId || typeof loginId !== "string") throw new BadRequestException("Falta el identificador del inicio de sesión.");
    const desafio = await this.consumirDesafio(this.claveDesafio("auth", loginId, rp.rpId));

    const credId = typeof (response as { id?: unknown })?.id === "string" ? (response as { id: string }).id : "";
    if (!credId) throw new BadRequestException("Respuesta de passkey inválida.");

    const credencial = await this.prisma.admin.webauthnCredential.findUnique({ where: { credentialId: credId } });
    // Mensaje UNIFORME a propósito: no revelamos si la credencial no existe, es de otra marca o
    // la firma no cuadra — todo es "no se pudo iniciar sesión con este aparato".
    if (!credencial || credencial.rpId !== rp.rpId) {
      throw new UnauthorizedException("No se pudo iniciar sesión con este aparato.");
    }

    let verificacion: VerifiedAuthenticationResponse;
    try {
      verificacion = await verifyAuthenticationResponse({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lo valida la librería
        response: response as any,
        expectedChallenge: desafio,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpId,
        // Explícito: garantiza que hubo cara, dedo o PIN. Es lo que convierte esto en 2FA.
        requireUserVerification: true,
        credential: {
          id: credencial.credentialId,
          publicKey: new Uint8Array(Buffer.from(credencial.publicKey, "base64url")),
          counter: credencial.counter,
          transports: transportesDe(credencial.transports),
        },
      });
    } catch {
      throw new UnauthorizedException("No se pudo iniciar sesión con este aparato.");
    }
    if (!verificacion.verified) throw new UnauthorizedException("No se pudo iniciar sesión con este aparato.");

    // Anti-clonación: el contador del autenticador debe avanzar. Lo persistimos junto con
    // `lastUsedAt` (best-effort: si la escritura falla, la sesión igual se emite — no vamos a
    // dejar a la persona afuera por no poder anotar la marca de tiempo).
    await this.prisma.admin.webauthnCredential
      .update({ where: { id: credencial.id }, data: { counter: verificacion.authenticationInfo.newCounter, lastUsedAt: new Date() } })
      .catch(() => undefined);

    return { userId: credencial.userId };
  }
}

/** Nombre del aparato: recortado, sin saltos de línea y con un valor por defecto decente. */
export function limpiarEtiqueta(etiqueta: string | undefined | null): string {
  const limpio = (etiqueta ?? "").replace(/\s+/g, " ").trim().slice(0, LARGO_MAX_ETIQUETA);
  return limpio || "Este dispositivo";
}

/** `transports` viaja como Json en la base; de vuelta tiene que salir como arreglo de texto. */
export function transportesDe(valor: unknown): ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[] {
  if (!Array.isArray(valor)) return [];
  const validos = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
  return valor.filter((v): v is (typeof validos)[number] => typeof v === "string" && (validos as readonly string[]).includes(v));
}

/** Fila → lo que ve el panel. Nunca sale `publicKey` ni `counter`: no le sirven a nadie afuera. */
function aVista(fila: {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string | null;
}): AparatoConAcceso {
  return {
    id: fila.id,
    label: fila.label,
    createdAt: fila.createdAt.toISOString(),
    lastUsedAt: fila.lastUsedAt ? fila.lastUsedAt.toISOString() : null,
    sincronizada: fila.deviceType === "multiDevice",
  };
}
