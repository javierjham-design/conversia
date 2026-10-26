# PROMPT DE DESARROLLO — Sesión, cerrar sesión y manejo del token vencido (conversia-web)

**Para el desarrollador (Claude Code en VS Code, con agentes).** Hallazgo en producción
(26-oct-2026), reportado por el dueño y verificado en el código:

1. El JWT del panel dura **12 h** (`JWT_EXPIRES_IN`, default en `packages/config/src/index.ts:40`),
   pero el frontend trata el token como eterno: `apps/conversia-web/src/app/page.tsx:31`
   redirige al panel con que el token *exista* en localStorage, sin validar que siga
   vigente. Resultado: días después, conversia.cl te "mete" a un panel con sesión muerta.
2. `apps/conversia-web/src/lib/api.ts` **no maneja el 401**: con el token vencido cada
   llamada falla y la UI muestra errores aleatorios — p. ej. el Asistente Conversia
   respondiendo "No pude responder en este momento 🙏" (`SupportWidget.tsx:81`) cuando el
   problema real era la sesión, no la IA.
3. El panel cliente **no tiene botón de cerrar sesión**: `clearToken()` existe en
   `lib/api.ts` pero nadie lo llama en el panel (solo el admin de plataforma en
   `app/admin/layout.tsx` tiene logout). El dueño no puede salir ni re-entrar.

No es una brecha del servidor (la API rechaza el token vencido con 401), pero sí parece
una brecha para el usuario y es una experiencia rota. Arreglar en este orden:

## BLOQUE 1 — Manejo global de la sesión vencida (prioridad 1)

- En `lib/api.ts`: ante **401** en una llamada autenticada (había token), hacer
  `clearToken()` y redirigir a `/login?expirada=1&volver=<ruta actual>`. En `/login`,
  si viene `expirada=1`, mostrar aviso amable ("Tu sesión expiró, entra de nuevo") y tras
  el login exitoso volver a `volver`. Excluir de este comportamiento las rutas públicas y
  el login mismo (un 401 por contraseña mala NO debe redirigir en bucle).
- En `app/page.tsx` (landing): antes de redirigir a `/inicio`, validar el token —
  basta decodificar el payload del JWT client-side y comparar `exp` con el reloj (sin
  llamada de red); si está vencido, `clearToken()` y mostrar la landing con el CTA de
  entrar. Nada de pantallas en blanco.
- El `SupportWidget` ya distingue estados por código HTTP: con este cambio el 401 jamás
  le llega (redirige antes). Verificar que ningún otro componente trague el 401 en un
  `catch` genérico.

## BLOQUE 2 — Cerrar sesión en el panel cliente

- Botón **"Cerrar sesión"** visible en `components/AppShell.tsx` (menú del usuario o al
  final de la navegación) y también en la pantalla **Ajustes**: `clearToken()` +
  redirección a `/login`. Ícono `LogOut` como en el admin.
- Si la API tiene (o es trivial agregar) un endpoint de revocación/lista negra del
  token, llamarlo best-effort antes de limpiar; si no, dejar TODO anotado — el logout
  client-side sale hoy igual.

## BLOQUE 3 — Política de sesión pensada para móvil

El cliente objetivo usa el panel desde el celular y espera **no** tener que loguearse
cada 12 h (como WhatsApp/apps bancarias ligeras). Implementar sesión deslizante:

- **Refresh token** de larga vida (p. ej. 30 d, rotativo, revocable, guardado aparte del
  access token) + access token corto (las 12 h actuales o menos). `lib/api.ts` renueva
  solo: ante 401, intenta refresh UNA vez y reintenta la llamada; si el refresh también
  falla, recién ahí corre el flujo del Bloque 1. Duraciones por env
  (`JWT_EXPIRES_IN`, nueva `JWT_REFRESH_EXPIRES_IN`), nunca hardcodeadas.
- Acciones sensibles (cambiar contraseña, datos de cobro) pueden exigir re-login aunque
  la sesión deslizante esté viva — anotar dónde aplicaría, no hace falta implementarlo ya.
- **Fase 2 (solo TODO + nota en el runbook):** passkeys/WebAuthn para que en el celular
  el cliente entre con Face ID/huella en vez de contraseña. No implementar ahora; dejar
  el diseño apuntado para cuando se priorice.

## Alcance y cierre

- Alcance: **conversia-web** (y la API en lo que pida el refresh token). Si el panel de
  TuBot (`apps/web`) comparte el mismo patrón de token, SOLO anotar el hallazgo en el
  entregable — **TuBot está en producción y no se toca su funcionamiento** sin OK
  explícito del dueño.
- Tests: unitarios del helper (401 → clear+redirect; refresh exitoso reintenta; refresh
  fallido redirige; login con contraseña mala no redirige en bucle) + Playwright del
  flujo completo (token vencido inyectado → aviso de sesión expirada → login → vuelve a
  la ruta original; logout desde AppShell).
- Corre typecheck + tests del monorepo. PR único con evidencia.
- Entregable: `docs/SESION_RESULTADOS.md` con qué quedó implementado, duraciones
  elegidas y el hallazgo sobre TuBot si existe.

## Reglas duras

TuBot intacto · nada de credenciales en texto plano ni en commits · prohibido marcar
verde algo que un test o navegador no haya visto funcionar · el 401 del login por
contraseña incorrecta NUNCA debe disparar el redirect global.
