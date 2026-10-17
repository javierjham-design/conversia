# QA de Producción — Resultados

**Fecha:** 2026-10-17 · **Suite:** `tools/sim/smoke-prod.mjs` (solo lectura contra prod real) + barrido con agentes.

## 1. Suite de humo `smoke-prod.mjs` (corrida contra prod)

Node puro, sin dependencias (fetch nativo), solo lectura, `exit 1` si hay FAIL. Comando: `node tools/sim/smoke-prod.mjs`. Integrada en CI como `.github/workflows/smoke-prod.yml` (manual post-deploy + canario diario; no corre en PR porque apunta a prod).

| # | Check | Resultado |
|---|---|---|
| 1 | Dominios arriba (conversia.cl, www, app, tubot.cl, API /health) + TLS | ✅ PASS (todos 200) |
| 2 | Bundle sin `localhost`/`127.0.0.1` + URL pública de la API presente | ✅ PASS (18 chunks, 0 con localhost) |
| 3 | CORS por dominio (3 orígenes Conversia + TuBot; ajeno rechazado) | ✅ PASS |
| 4 | Endpoints del funnel (`/public/verticals` ≥14, packs=3, plans, `/billing/plans`→401) | ✅ PASS **(tras fix — ver §3)** |
| 5 | Headers (CSP+connect-src, HSTS, `_next/static` immutable, HTML `s-maxage`≤300) | ⚠️ **FAIL** → acción operativa (ver §4) |
| 6 | Caché/versión (mismo buildId en conversia.cl y app.conversia.cl, 0 chunks rotos) | ✅ PASS |
| 7 | Enlaces internos de la landing (<400) | ✅ PASS |
| 8 | Consola limpia (navegador headless) | ⏭️ SKIP (sin headless en el entorno; verificación manual) |
| 9 | Seguridad de borde (webhook mock→403, mock-confirm→401, API key inválida→401) | ✅ PASS |

**Los 3 bugs de entorno del 17-oct (PR #492):** bundle sin `NEXT_PUBLIC_API_URL` → **CORREGIDO y sostenido** (check 2); CORS solo app.conversia.cl → **CORREGIDO y sostenido** (check 3); caché HTML de 1 año → **sigue fallando por regla del borde** (check 5, ver §4).

## 2. Hallazgos del barrido (agentes)

**Frontend (Agent B):** consola **limpia** (0 `console.*` en conversia-web), **sin secretos en el bundle**. Único riesgo: el fallback de `api-base.ts` solo cubría `*.conversia.cl` → **CORREGIDO** en este PR (ahora cualquier host real usa la API pública; localhost solo en dev). Hazards server-side (defaults mock/dev en `packages/config` que en prod solo *avisan*, no lanzan) → §5.

**Enlaces (Agent LINKS, integrado en el smoke):** todos los href internos de la landing responden (<400). ✅

## 3. FAIL 4 — rubros del funnel incompletos → CORREGIDO

**Causa raíz:** `/public/verticals` devolvía **6** rubros; el seed (`vertical-templates.json`) define **14** wave-1. Los `vertical_templates` de prod estaban desactualizados (faltaban medspa, veterinaria, kinesiología, taller, servicios a domicilio, psicología, abogados, gimnasio) → clientes de esos 8 rubros no podían auto-registrarse con su rubro.

**Fix (datos, no código — el código del seed ya tenía los 14):** script acotado `packages/database/scripts/seed-verticals-only.mjs` (upsert idempotente SOLO de `vertical_templates`; **NO toca planes ni tenants** — a diferencia del seed completo, que resetearía `conversia_v2_base` a inactivo). Corrido en prod.

**Antes → Después:** 6 rubros públicos → **14** (verificado en vivo: `abogados, barberia, centro_medico, dental, estetica, generico, gimnasio, kinesiologia, medspa, peluqueria, psicologia, servicios_domicilio, taller, veterinaria`).

## 4. FAIL 5 — caché HTML de 1 año → ACCIÓN OPERATIVA DEL DUEÑO (no es código)

El HTML de prod se sirve con `cache-control: s-maxage=31536000` (1 año) en `/`, `/crear`, `/registro`, `/login`. **El código es correcto:** `apps/conversia-web/next.config.mjs` (PR #492) setea `public, max-age=0, s-maxage=60, stale-while-revalidate=300` y está desplegado (su CSP aparece en prod). El valor "pelado" `s-maxage=31536000` NO lo genera Next → lo **sobrescribe una regla del borde (Cloudflare Cache Rule / Transform Rule, o Railway)**.

**Acción (Javier, en Cloudflare):** quitar/ajustar la Cache Rule que fija Edge TTL de 1 año al HTML — el HTML debe hacer *bypass* o TTL ≤ 300 s para no servir versiones viejas tras cada deploy. (El único `31536000` legítimo del código es el **HSTS**, que está bien.) Re-correr `smoke-prod.mjs` tras el ajuste → check 5 debe pasar.

## 5. Checklist de entorno Railway (verificación del dueño en el dashboard)

El boot-guard de prod ya garantiza `JWT_SECRET` y `CREDENTIALS_ENCRYPTION_KEY` reales (api/worker no arrancarían si no). **A verificar/endurecer** (hoy en prod solo *avisan* o dependen de env):

- **conversia-web:** `NEXT_PUBLIC_API_URL` debe estar seteada como **variable de BUILD** (Next la inlinea en el bundle; una var de runtime no sirve) y no-localhost. Rebuild tras setearla.
- **api/worker:** `AI_PROVIDER`≠`mock`, `WHATSAPP_PROVIDER`=`meta`, `SCHEDULING_PROVIDER`=`clariva` (no `mock`); `DIRECT_DATABASE_URL` seteada (si falta, login/resolución cross-tenant caen a la rol RLS).
- **api:** `META_VERIFY_TOKEN`≠`conversia-verify-token-dev` (y = valor del dashboard de Meta); `MOCK_INBOUND_TOKEN`≠`dev-mock-inbound-token`; `META_APP_SECRET` no vacío (si no, el webhook real no verifica firma); `SUPER_ADMIN_SESSION_SECRET` no vacío; `SUPER_ADMIN_REQUIRE_MFA`=true; `FLOW_BASE_URL` de prod (no sandbox) si hay cobro CLP; `WEB_URL`/`WEB_URL_CONVERSIA`/`API_URL` dominios https reales.
- **web (TuBot):** `API_URL` seteada (runtime) y no-localhost.

La tabla completa por servicio (crítica/opcional + valor esperado) está en el runbook (`RUNBOOK_GOLIVE_V2.md`). **Recomendación de código (follow-up, no en este PR por riesgo de brickear un deploy):** promover estos *avisos* a *throw* en `getEnv()` (como ya hace con JWT/encryption) para que un prod mal configurado no arranque silenciosamente en modo mock.

## 6. §3 — E2E real de registro (paso MANUAL del dueño)

Registrar en prod una cuenta `qa+<fecha>@conversia.cl` (rubro gimnasio) y verificar: paquete instalado, checklist de 7 pasos, 30 de regalo, simulador responde, `mock-confirm`→400 (pasarela real). Eliminarla al final desde la consola. **Se deja como paso manual** (toca datos/registro en prod; el smoke ya cubre todo lo verificable sin escribir). El registro público + los 14 rubros ya están validados (§3).

## 7. Veredicto

| Criterio | Estado |
|---|---|
| Dominios, bundle sin localhost, CORS por dominio, buildId consistente, enlaces, seguridad de borde | ✅ |
| Funnel completo (14 rubros públicos) | ✅ (corregido en prod) |
| Caché HTML ≤ 300 s | ⚠️ pendiente **acción Cloudflare del dueño** (código correcto) |
| Consola limpia | ✅ por código (sin headless para probar en vivo) |

**Conclusión:** prod está sano; los 2 bugs de #492 de bundle y CORS se sostienen; el funnel quedó completo (14 rubros). Queda **una** acción operativa (Cloudflare cache rule) y el checklist de env para que el dueño verifique en el dashboard. El smoke queda como canario diario + job manual post-deploy para que esta familia de bugs no vuelva a pasar sin avisar.
