# Entrar a TuBot con Face ID o huella

Encargo para llevar al panel de **TuBot** (`apps/web`) lo que P1 ya dejó en Conversia.
El diseño de fondo —qué es un passkey, por qué el RP ID sale de la configuración, los riesgos—
está en **`docs/PROMPT_PASSKEYS_BIOMETRIA.md`** y no se repite acá. Esto es solo lo que cambia
para TuBot.

---

## 1. La noticia buena: el backend YA está hecho

**No hay que escribir una sola línea de API.** Lo que entró con el PR #654 es consciente de la
marca de nacimiento:

- `rpDeLaMarca()` (`apps/api/src/auth/passkeys.service.ts`) resuelve la marca con `brandOf()`, y
  de ahí saca el dominio dueño de la llave y los orígenes válidos.
- Las cinco rutas `/auth/passkeys*` no están atadas a ninguna marca.
- El modelo `WebauthnCredential` y su migración **ya están aplicados en producción**
  (16-nov-2026), y la columna `rp_id` separa las credenciales por dominio.

**Verificado contra las variables de producción**, no supuesto:

| | env | RP ID que sale |
|---|---|---|
| TuBot | `WEB_URL=https://www.tubot.cl` | **`tubot.cl`** |
| Conversia | `WEB_URL_CONVERSIA=https://app.conversia.cl` | **`conversia.cl`** |

`baseHostOf` le quita el `www.` y el `app.`, así que el RP ID es el apex y cubre los dos hosts
de cada marca. Los orígenes aceptados salen de `allowedOriginsOf`, la **misma** lista que usa el
CORS de la api.

→ **Este encargo es de interfaz nada más.** Un PR.

---

## 2. Un passkey de Conversia NO sirve en TuBot, y está bien

Son dominios distintos, así que son RP distintos: una llave emitida para `conversia.cl` no se
puede usar en `tubot.cl` ni al revés. Eso **calza con el modelo de cuentas**, que ya es separado
(`User @@unique([email, brand])`: el mismo correo puede tener una cuenta en cada marca, con sus
orgs y su plan aparte).

Consecuencia práctica que hay que decirle a la persona en pantalla, no esconder: **quien use las
dos marcas tiene que activar el aparato en cada una.** No es un error ni algo que se pueda
arreglar; es cómo funciona WebAuthn.

---

## 3. Dónde va la pantalla

**`apps/web/src/app/(app)/settings/profile/`**, como un componente `passkeys-card.tsx` que se
renderiza en `page.tsx` **al lado de `<MfaCard />`** (hoy en la línea 123).

Es el lugar correcto y no es una opinión: ahí vive ya la tarjeta de verificación en dos pasos
(`mfa-card.tsx`), que es la otra forma de proteger el acceso. `/settings` redirige a
`/settings/general`, así que no hay un hub de tarjetas donde pegarla.

**NO copies el componente de Conversia tal cual.** Los dos frontends no comparten estilos:

| | conversia-web | apps/web (TuBot) |
|---|---|---|
| Estilos | `style={{...}}` en línea + variables CSS (`--acc`, `--line`) | **sistema de componentes** `@/components/ui` |
| Avisos | `<p style={{color:"var(--ok)"}}>` | **`useToast()`** |
| Botones | `className="btn-accent"` | **`<Button>`** |
| Spinner | `className="lp-spin"` + `<style>` local | revisar qué usa `mfa-card.tsx` |

Mira `mfa-card.tsx` y espéjalo: `Button`, `Checkbox`, `cn`, `useToast`, `Skeleton` salen todos de
`@/components/ui`. La lógica sí se puede leer de
`apps/conversia-web/src/components/PasskeysSettings.tsx` — pero la lógica, no el marcado.

---

## 4. La trampa propia de TuBot: el `Origin` a veces no viaja

Acá los dos paneles NO se comportan igual, y conviene saberlo antes de depurar a ciegas.

- **conversia-web** llama a la API **cross-origin** (`NEXT_PUBLIC_API_URL`), así que el navegador
  manda `Origin` siempre.
- **TuBot** llama por un **proxy same-origin**: `API_URL = "/backend"` (`apps/web/src/lib/api.ts`)
  y el proxy vive en `apps/web/src/app/backend/[...path]/route.ts`, que reenvía todas las
  cabeceras menos `host` y `connection`.

En una petición same-origin el navegador manda `Origin` en los POST pero **no en los GET**. O sea
que `GET /auth/passkeys` (la lista de aparatos) llega **sin `Origin`**, y `brandFromOrigin(undefined)`
devuelve `"tubot"` por ser **la marca por defecto**.

**Funciona, pero funciona por el default, no porque el dato esté.** El día que alguien cambie la
marca por defecto, la lista de aparatos de TuBot empezaría a buscar credenciales con el `rp_id`
equivocado, y en pantalla se vería como «se borraron mis aparatos» — sin ningún error.

Dos formas de cerrarlo, y **elegir una es parte de este encargo**:

- **(a) Un guardián, sin tocar código de producción.** Un test que afirme que
  `brandFromOrigin(undefined) === "tubot"` **y que esa es la marca de la que sale el `rp_id` de
  `apps/web`**, con un comentario que explique que la lista de aparatos depende de ese default.
  Barato y suficiente, porque el default no cambia por accidente.
- **(b) Que el proxy mande un `Origin` explícito** en
  `apps/web/src/app/backend/[...path]/route.ts`. Deja de depender del default, pero toca el camino
  por el que pasan TODAS las llamadas del panel de TuBot, así que hay que medir que no rompa nada
  más (el CORS de la api ya acepta ese origen).

Recomendación: **(a)** en este PR. (b) es un cambio de infraestructura que no debería viajar
escondido en una entrega de interfaz.

---

## 5. Lo que NO hay que tocar

- **La sesión de TuBot no cambia en este encargo.** TuBot **nunca** recibió refresh token (§10.2
  del runbook): su sesión es el access token de 12 h, sin claim `sxp`. Hay **dos tests de
  regresión** que encierran eso a propósito en `apps/api/test/sesion-maximo-24h.spec.ts` §5
  («REGRESIÓN TuBot: su login sigue idéntico»). Si se ponen rojos, algo se cruzó.
- Por lo mismo, **el equivalente de P3 (sesión viva sin techo de 24 h) es MÁS grande en TuBot que
  en Conversia**: allá la maquinaria de sesión deslizante ya existe; acá habría que cablear antes
  `setSession` + refresh-en-401 en `apps/web/src/lib/api.ts`. **Fuera de alcance de este encargo.**
- `JWT_EXPIRES_IN` lo comparten las dos marcas y `users.controller.ts` documenta la decisión de no
  tocarlo.

---

## 6. Guardianes que hay que poner

Espeja los de Conversia, que están en `apps/conversia-web/src/lib/passkeys-permisos.test.ts`, y
**rómpelos a propósito** antes de pushear (regla de la casa: un guardián que solo se vio en verde
no vigila nada).

1. **La política de permisos no apaga WebAuthn.** Hoy `apps/web/next.config.mjs` trae
   `camera=(), microphone=(), geolocation=(), browsing-topics=()` — limpia. El guardián tiene que
   ponerse rojo si aparece `publickey-credentials-get=()` o `-create=()` sin `self`. Es el mismo
   fallo que ya se envió una vez con el micrófono en Conversia.
2. **La tarjeta está realmente renderizada** en `settings/profile/page.tsx`, no solo importada.
3. **La CSP no cambia** y conviene dejarlo escrito: WebAuthn es una API del navegador, no un
   recurso que se descargue de ningún host.

**Ojo con el CI:** el job `e2e-robustness` es **REQUERIDO** y corre sobre `apps/web` con Playwright
`^1.62.1`. Si agregas la tarjeta a una pantalla que ese smoke carga, tiene que seguir soportando
datos incompletos (es lo que ese job prueba: cada pantalla con un tenant vacío y registros en
`null`). Una tarjeta que reviente sin datos tumba un check obligatorio.

---

## 7. Qué decirle a la persona en la pantalla

Lo mismo que en Conversia, porque es lo que de verdad importa y casi nadie lo sabe:

> Tu huella y tu cara **no salen de tu teléfono**. El aparato guarda una llave y tu biometría solo
> la destraba.

Y dos avisos honestos: que **la contraseña sigue funcionando** (el passkey es una vía más, nunca
la única: quien pierda el teléfono tiene que poder entrar), y que si usa TuBot y Conversia,
**tiene que activarlo en cada una**.

---

## 8. Alcance, en una línea

Un componente nuevo, una línea en `page.tsx`, un archivo de tests y nada de backend. La migración
ya está en producción, así que **este PR no necesita migrar nada antes de mergearse** — es el único
de la serie que no arrastra ese requisito.
