# PROMPT DE DESARROLLO — QA DE PRODUCCIÓN REAL (humo post-deploy + caza de detalles de entorno)

**Para el desarrollador (Claude Code en VS Code, con agentes).** Las simulaciones locales
(tandas 1 y 2) validan la LÓGICA, pero el 17-oct se nos escaparon a producción tres
bugs **de entorno** que ninguna simulación local puede ver:

1. El bundle de `conversia-web` se publicó SIN `NEXT_PUBLIC_API_URL` → todo el panel
   llamaba a `http://localhost:4000` (muerto para cualquier visitante).
2. **CORS solo permitía `app.conversia.cl`** → la landing y el generador en
   `conversia.cl` / `www.conversia.cl` fallaban EN SILENCIO ("Cargando rubros…").
3. El HTML se publicaba con `s-maxage=31536000` (1 año) → Cloudflare servía versiones
   viejas después de cada deploy (el bug ya corregido se "seguía viendo").

**Estas tres clases de error no pueden volver a pasar a ningún nivel.** Tu misión:
construir la suite de humo que corre CONTRA PRODUCCIÓN REAL después de cada deploy y
barrer toda la plataforma en busca de más detalles de esta familia.

## 1. Entregable principal: `tools/sim/smoke-prod.mjs`

Script Node sin dependencias (fetch nativo) que se corre con
`node tools/sim/smoke-prod.mjs` (y en CI como job post-deploy). SOLO LECTURA: jamás
escribe datos en producción (ninguna cuenta, ningún POST que mute — la única excepción
permitida es el flujo de registro+borrado documentado en §3). Verifica y reporta
PASS/FAIL por punto:

1. **Dominios arriba**: conversia.cl, www.conversia.cl, app.conversia.cl, tubot.cl,
   API /health → 200 y TLS válido.
2. **Bundle sin parámetros locales**: descarga el HTML de /, /crear, /registro, /login
   y TODOS sus chunks JS; FALLA si algún chunk contiene `localhost:` o `127.0.0.1`
   fuera del fallback documentado de `api-base.ts`, o si NO contiene la URL pública de
   la API (señal de build sin variable).
3. **CORS por dominio**: preflight (`OPTIONS` + `Origin`) a `/public/verticals` desde
   conversia.cl, www.conversia.cl y app.conversia.cl → los tres deben devolver
   `access-control-allow-origin` correcto. Igual para los orígenes de TuBot.
4. **Endpoints públicos del funnel**: `/public/verticals` (≥14 rubros tras el seed),
   `/public/conversation-packs?brand=conversia` (3 packs), `/billing/plans` exige auth.
5. **Headers**: CSP presente y que `connect-src` incluya la API; `Cache-Control` del
   HTML con `s-maxage` ≤ 300; `/_next/static/*` con `immutable`; HSTS presente.
6. **Caché/versión**: el HTML referencia chunks que EXISTEN (200) — detecta HTML viejo
   cacheado apuntando a chunks purgados; imprime el buildId para comparar entre dominios
   (conversia.cl y app.conversia.cl deben servir el MISMO build).
7. **Consola limpia**: carga `/`, `/crear`, `/login` con un navegador headless si hay
   uno disponible en el entorno (si no, salta este punto y dilo) y FALLA ante cualquier
   error de consola que no esté en la allowlist documentada.
8. **Seguridad de borde (no destructivo)**: webhook con payload `mock:` → 403;
   `/billing/mock-confirm` sin sesión → 401; con una API key inválida `cnvk_x` → 401.

## 2. Barrido único de "detalles de entorno" (se hace una vez, con agentes)

En paralelo al script, lanza agentes para auditar:
- **Agente ENV**: cruza `.env.example` contra las variables reales de cada servicio de
  Railway (api, worker, web, conversia-web): ¿qué falta, qué sobra, qué quedó con valor
  de desarrollo? Entregable: tabla con severidad. (Las variables las revisa Javier en el
  dashboard si no hay acceso; el agente entrega la LISTA exacta de qué mirar.)
- **Agente FRONTEND**: grep de TODO el monorepo publicable buscando `localhost`,
  `127.0.0.1`, puertos de dev, tokens/claves de ejemplo, `console.log` ruidosos y TODOs
  críticos en rutas servidas.
- **Agente LINKS**: recorre la landing y el panel (anónimo) y verifica que cada href
  interno responda (nada de 404 en la campaña).
- **Agente DOCS**: el runbook RUNBOOK_GOLIVE_V2.md queda actualizado con lo que
  encuentres (es el documento operativo de verdad).

## 3. Prueba de punta a punta REAL (controlada y con limpieza)

Una vez por release: registrar en producción UNA cuenta de prueba
(`qa+<fecha>@conversia.cl`, rubro gimnasio), verificar: paquete instalado, checklist de
7 pasos con "método de pago", 30 de regalo, simulador del agente responde, y
`mock-confirm` devuelve 400 (pasarela real configurada). Al final, eliminarla desde la
consola de plataforma y dejar constancia en el informe. Si algo de esto no se puede
verificar sin tocar dinero real, se documenta como paso manual de Javier.

## 4. Proceso con agentes y entregables

1. Agente A implementa `smoke-prod.mjs` (punto 1) con salida JSON + resumen legible.
2. Agentes B/C/D hacen el barrido (punto 2) en paralelo.
3. Tú corres la suite contra producción, triageas, y cada hallazgo real → fix + test +
   PR (un PR por bloque; causa raíz en la descripción).
4. Integra `smoke-prod.mjs` como job de CI post-deploy (o documenta el comando en el
   runbook si CI no puede llegar a producción).
5. Entregable final: `docs/QA_PRODUCCION_RESULTADOS.md` con la tabla de puntos
   PASS/FAIL, hallazgos, fixes y lo que queda como paso manual.

## Reglas duras

- TuBot no se toca (sus dominios se verifican en modo lectura solamente).
- Nada de escrituras en producción fuera del §3; nada de datos de clientes reales en
  informes; ningún secreto impreso en logs ni commits.
