# Entrar con Face ID / huella y sesión viva en el teléfono

**Decisión del dueño (16-nov-2026):** en el **teléfono** la sesión vive **sin el techo de 24 h**, y
la **biometría del equipo** es lo que la sostiene. En el navegador de escritorio **no cambia nada**:
sigue en 24 h.

Este documento es el encargo. Reemplaza la nota «Fase 2, solo diseño» de `RUNBOOK_GOLIVE_V2.md` §15
y hay que leerlo junto a ella: la política de 24 h que esa sección fija sigue rigiendo para todo lo
que **no** tenga una llave de aparato detrás.

---

## 1. Lo primero, porque cambia cómo se piensa el problema

**La huella y el Face ID nunca salen del teléfono.** El equipo guarda una llave privada en su chip
seguro y la biometría solo sirve para destrabarla; el servidor guarda únicamente la llave pública.
No viaja ningún dato biométrico, no hay nada biométrico que se pueda filtrar, y la llave queda
**amarrada al dominio**: una página falsa no la puede usar ni pidiéndola.

**WebAuthn es la única vía.** Desde una página web la biometría del teléfono no se alcanza por
ningún otro API: no existe `navigator.biometrics`. La única alternativa sería envolver el PWA en una
app nativa (Capacitor + `LocalAuthentication` / `BiometricPrompt`), lo que significa otra base de
código y dos tiendas de apps. No ahora.

Y el «dependiendo del equipo» sale gratis: no se programa nada por dispositivo. Se le pide al
navegador *«un autenticador del propio aparato, con verificación de la persona»* y cada sistema pone
lo que tenga — iPhone: Face ID o Touch ID; Android: huella o cara; Windows: Hello.

---

## 2. El eje real NO es «¿es un celular?»

**La trampa central de este encargo.** `sessionMode` (cabecera `x-session-mode`,
`auth.controller.ts`) es un dato que **manda el cliente**. Si el techo largo se concediera por
`x-session-mode: device`, cualquiera manda esa cabecera con `curl` y se lleva una sesión que no
caduca nunca. Lo mismo vale para el User-Agent: «parece un teléfono» no es una credencial.

→ El techo largo se concede **solo** a una sesión que el servidor ató criptográficamente a un
passkey registrado, y que **no se puede renovar sin una firma nueva de ese passkey**.

El eje es **«¿hay una llave de este aparato cuidando esta sesión?»**, no «¿parece un teléfono?».
Dos ventajas de paso: un escritorio con Windows Hello entra igual de rápido, y un teléfono **sin**
passkey se queda en las 24 h de siempre. Cero líneas de código por dispositivo.

---

## 3. Las tres piezas, y por qué son tres

### A. El passkey — la llave

Modelo nuevo `webauthn_credentials`: `userId`, `credentialId` (único), `publicKey`, `counter`,
`transports`, `rpId`, nombre del aparato, `createdAt`, `lastUsedAt`. Librería
`@simplewebauthn/server`.

Para **inscribir** un aparato hay que estar **dentro** (contraseña + TOTP). Se hace una vez, en el
teléfono, y no se vuelve a teclear nada nunca más.

### B. La sesión de aparato — la vida larga

`RefreshSessionData` (`refresh-session.service.ts`) gana un campo: `credentialId`. Una sesión que lo
trae:

- **ventana deslizante larga** — 30 d sin usarse y muere. «Viva mientras se usa» es exactamente eso.
- **sin techo absoluto** — `absoluteExpiresAt` ausente.
- **access token igual que hoy, 12 h, y sin claim `sxp`** (no hay techo que firmar).

### C. El portón en el SERVIDOR — lo que hace que esto sea seguridad y no decorado

`POST /auth/refresh` sobre una sesión con `credentialId` **exige una aserción WebAuthn fresca de ese
mismo passkey**. Sin firma válida → 401.

Esta es la pieza que no se puede negociar. Un candado de huella dibujado en el cliente («si la
biometría dice ok, muestro el panel») es una cortina: el refresh token está en `localStorage` y la
comprobación es un booleano de JavaScript. Con el portón en el servidor, **un refresh token robado
no sirve para nada** sin la cara o el dedo del dueño en ese aparato.

Y un efecto lateral que conviene tener presente: si mañana alguien inyecta un script en el panel,
puede usar el access token que ya está vivo, pero **no puede renovarlo** (no tiene cómo firmar). El
daño se corta a lo que quede de esas 12 h en vez de durar 30 días.

---

## 4. Lo que la persona va a sentir

Abre la app → Face ID → dentro. Una vez cada ~12 h, cuando el access token muere.

**Decirlo claro para que no haya malentendido: el Face ID va a seguir apareciendo una vez al día.
Eso es la función, no un resto por pulir.** Lo que desaparece para siempre es **teclear**: nunca más
el correo, la contraseña ni el código de 6 dígitos.

---

## 5. Los tres caminos de #609, ahora al revés

El techo de 24 h era de mentira por tres caminos a la vez, y se arregló por los tres (#609,
`test/sesion-maximo-24h.spec.ts`). Levantarlo para el teléfono obliga a recorrer los mismos tres. Si
se toca uno solo, queda roto o queda falso.

**1. `techoDeLaSesion` toma el MÍNIMO entre el techo guardado y el de la política de hoy**, a
propósito: *«una política nueva solo puede ACORTAR»*. Consecuencia directa: **no sirve subir
`JWT_REFRESH_ABSOLUTE_MAX`.** No alcanzaría a ninguna sesión ya abierta y, de paso, alargaría
también las de escritorio. El techo tiene que ser **propiedad de la sesión**: con `credentialId` →
sin techo; sin él → 24 h como hoy. Y «sin techo» solo puede salir de la **presencia** de
`credentialId`, nunca de la **ausencia** de `absoluteExpiresAt`: una sesión vieja que no lo trae se
cuenta desde su `createdAt`, como hoy. Invertir eso vuelve eternas las sesiones viejas, que es
textualmente el bug original.

**2. `vidaDelAccessToken` le recorta el `exp` al techo.** Sin techo no hay recorte: 12 h limpias. La
firma pasa a `techoMs?: number`; representar «sin techo» con `Infinity` funciona de casualidad
(`Math.min(43200, Infinity)`), y por eso no se usa: `undefined` explícito.

**3. `/auth/switch-org` hereda el techo en curso.** Ahora tiene que heredar **también el
`credentialId`**. Si no, cambiar de organización convierte una sesión de aparato en una normal — o,
peor, lava una sesión normal y la deja sin techo. Es exactamente la forma del tercer agujero.

---

## 6. El guardián de las 24 h: enseñarle el eje nuevo, NO borrarlo

`apps/api/test/sesion-maximo-24h.spec.ts` se va a poner **rojo**. Está haciendo su trabajo. Lo que
corresponde:

- **los tres tests del bloque 0 (la configuración EN VIGOR) se quedan intactos**:
  `JWT_REFRESH_ABSOLUTE_MAX` sigue en 24 h, porque sigue siendo el techo de las sesiones **sin**
  passkey;
- se agrega un bloque nuevo: una sesión **con** `credentialId` no tiene techo, y una **sin**
  `credentialId` sigue muriendo a las 24 h **pida lo que pida por cabecera**;
- y el test que de verdad importa: **`/auth/refresh` sobre una sesión de aparato, sin aserción → 401**.

Los tres se rompen a propósito antes de pushear (ver `feedback_verificar_antes_de_pushear`).

---

## 7. Riesgos, sin maquillaje

1. **«Biometría», en la práctica, es «desbloqueo del equipo».** iOS acepta el código del teléfono
   como sustituto del Face ID y WebAuthn lo da por cumplido (`userVerification`). Quien sepa el PIN
   del teléfono entra. No se puede evitar: es cómo funciona la plataforma. Sigue siendo bastante
   mejor que una contraseña tecleada en un navegador.
2. **Teléfono perdido.** Hace falta la pantalla **«Aparatos con acceso»** con su botón de quitar, que
   revoca la credencial **y** las sesiones que dependían de ella. El passkey se sincroniza por
   iCloud / Google Password Manager, así que un teléfono nuevo lo recupera y el perdido sigue
   necesitando la cara del dueño.
3. **Sin techo = una credencial que nadie audita.** Mitigaciones: la ventana deslizante de 30 d la
   mata por desuso, la lista de aparatos la hace visible, y cambiar la contraseña revoca todas las
   sesiones (ya lo hace hoy).
4. **Redis caído = nadie entra**, porque el desafío vive ahí y `resolve` es fail-closed. Ya es así
   hoy; esto no lo empeora.

---

## 8. Decisión que queda abierta (dueño)

**¿El passkey con biometría reemplaza al código TOTP de 6 dígitos?**

Recomendación: **sí**. Tener el aparato más verificarse en él ya son dos factores, y es como lo
trata el estándar. Si no, el dueño pone la cara *y* teclea el código, que mata casi toda la
ganancia. Afecta a `requireMfaForAdmins` (`org.settings.security`).

**La contraseña se queda como respaldo.** Passkey como vía adicional, nunca la única: si alguien
pierde el teléfono y no hay otra puerta, queda afuera de su propia cuenta.

---

## 9. Trampas de implementación

- **RP ID por marca.** Un passkey está amarrado a UN dominio. `conversia.cl` como RP ID cubre
  `conversia.cl` **y** `app.conversia.cl` (es subdominio), pero **no** `tubot.cl`. Sale del Origin
  con la misma lógica de `brandFromOrigin` (`packages/config/src/brands.ts`). Escrito fijo en el
  código, los passkeys de la otra marca fallan **en silencio**. Encaja con que `User` ya sea
  `@@unique([email, brand])`: las cuentas ya son por marca.
- **La identidad la decide la firma, no el cliente.** Con credenciales descubribles el autenticador
  manda el *user handle*; se **verifica la aserción y después** se busca al usuario. Nunca al revés
  (CLAUDE.md: jamás aceptar identidad del cliente).
- **El user handle es `User.id`, no el correo** — queda guardado dentro del autenticador del aparato.
- **El desafío va en Redis: un solo uso, TTL corto, fail-closed al resolver.** Mismo patrón que
  `refresh-session.service.ts`.
- **No rechazar por `counter === 0`:** los autenticadores de plataforma suelen reportar 0 siempre.
- **`/auth/passkey/login*` van a `PUBLIC_PREFIXES`** de `tenancy.middleware.ts`; `register*` NO (hay
  que estar dentro para inscribir).
- **`sessionExpiresAt` ausente ≠ sesión vencida** en el panel (`conversia_session_until`): ya está
  tratado así a propósito, porque conversia-web se despliega antes que la api. Una sesión sin techo
  manda el plazo deslizante, o nada.
- **Permissions-Policy y CSP están limpias hoy** (`camera=(), microphone=(self), geolocation=(),
  browsing-topics=()`, sin `publickey-credentials-*`; WebAuthn no es un recurso externo, así que la
  CSP no cambia). Vale un guardián como el de `microphone=()` en `adjuntos.test.ts`: el día que
  alguien agregue `publickey-credentials-get=()`, la biometría muere **sin un solo error visible**.
- **PWA en `standalone`:** los passkeys funcionan desde iOS 16.4 y en Android. **Hay que probarlo en
  el teléfono del dueño** — eso no se puede verificar desde acá.
- **TuBot (`apps/web`) no se toca.** Nunca recibió refresh token (§10.2) y dos tests de regresión lo
  encierran. Si algún día se quiere allá, es otra decisión.
- **La migración se aplica ANTES de mergear**: los 4 servicios autodespliegan en el merge y
  `withTenant` es una transacción (ver `reference_withtenant_tx_abort`).

---

## 10. El plan, un PR por etapa

| PR | Qué entra | ¿Afloja la política? |
|----|-----------|----------------------|
| **P1** | Migración + modelo + `@simplewebauthn/server` + inscribir / listar / quitar + pantalla «Aparatos con acceso». No toca la sesión. | No |
| **P2** | Login por passkey. Emite **la misma sesión de hoy** (techo 24 h). Ya se entra con la cara. | No |
| **P3** | Sesión de aparato: `credentialId` en Redis, sin techo, **aserción obligatoria en el refresh**, herencia en `switch-org`, guardián ampliado. | **Sí** |
| **P4** | Que no parezca un login: hoja de Face ID directa al volver, autocompletado `username webauthn`, inscripción sugerida tras el primer login en el teléfono. | No |

El orden es a propósito: **P1 y P2 entregan todo el valor que se siente y no aflojan nada.** P3 es el
único que mueve la política de sesión, va solo, y entra con su guardián y con la verificación de que
sin firma el refresh devuelve 401.
