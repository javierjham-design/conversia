#!/usr/bin/env node
/**
 * Falla si el repo lleva CREDENCIALES EN CLARO de una consola real.
 *
 * POR QUÉ EXISTE (28-oct-2026): `docs/HANDOFF_PLANNER_BLOQUE_B.md` quedó con la contraseña
 * y el **secreto TOTP** del super admin `sandbox.admin@conversia.cl` — un admin con rol
 * OWNER en la producción COMPARTIDA (TuBot + clientes reales). Cualquiera con lectura del
 * repo tenía la consola completa, segundo factor incluido. Gitleaks no lo vio: una
 * contraseña y un blob base32 escritos en un documento no calzan con ningún patrón de
 * proveedor. Y `seed-sandbox.mjs` traía la contraseña fija en el código, con el `railway
 * run` contra producción en su propio encabezado, así que la puerta se podía reabrir con
 * un comando.
 *
 * Tres reglas acotadas (nada de heurísticas de entropía: esto tiene que ser cero falsos
 * positivos para que nadie lo apague):
 *
 *  1. Un `otpauth://…secret=<valor literal>` en cualquier archivo. Enrolar un segundo
 *     factor desde el repo es exactamente la puerta trasera que apareció. Construir la URI
 *     con el secreto interpolado (`secret=${…}`) es legítimo y no cuenta.
 *  2. Un blob base32 de 16+ caracteres en una línea que habla de MFA/TOTP/2FA + secreto.
 *  3. Una contraseña literal asignada en un script que corre contra bases REALES
 *     (`packages/database/scripts/`, `tools/`): esos scripts la tienen que pedir por
 *     variable de entorno, como ya hace `db:seed` desde la auditoría §1.3.
 *
 * Uso: node tools/ops/check-plaintext-credentials.cjs
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..", "..");

/** Archivos RASTREADOS (lo que de verdad se publica), sin binarios ni lockfiles. */
function archivos() {
  const salida = execFileSync("git", ["ls-files", "-z"], { cwd: RAIZ, maxBuffer: 64 * 1024 * 1024 });
  return salida
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((f) => !/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(f))
    .filter((f) => !/\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|otf|pdf|zip|gz|mp4|webm)$/i.test(f));
}

/**
 * Base32 de verdad: MAYÚSCULAS y dígitos 2-7, 16+ caracteres, como token completo. Va
 * SIEMPRE sin la bandera `i`, y por eso vive aparte de las palabras clave: con `i` el
 * mismo patrón acepta minúsculas y entonces cualquier identificador largo (`mfaSecret`,
 * `generateTotpSecret`) se ve como un secreto. Esa versión ingenua daba 11 falsos
 * positivos sobre el código del propio MFA.
 */
const B32 = /\b[A-Z2-7]{16,}\b/;
const reglas = [
  {
    id: "otpauth-con-secreto-literal",
    // secret= seguido de base32 literal (no `${...}`): un segundo factor enrolable desde el repo.
    re: /otpauth:\/\/[^\s`'"]*secret=[A-Z2-7]{16,}/,
    porQue: "una URI otpauth con el secreto literal enrola el segundo factor de esa cuenta",
  },
  {
    id: "secreto-mfa-en-texto",
    re: /(mfa|totp|2fa|dos pasos)[^\n]{0,60}(secreto|secret|clave)/i,
    ademas: B32, // y en la misma línea, un blob base32 de verdad
    porQue: "es el segundo factor de una cuenta real escrito en claro",
  },
  {
    id: "password-literal-en-script",
    re: /(?:const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|CLAVE)[A-Za-z0-9_]*\s*=\s*["'`][^"'`$\n]{6,}["'`]/,
    // Scripts que se corren contra bases de datos REALES. Las fixtures de e2e (stack
    // desechable) quedan fuera a propósito: ahí una contraseña fija es el dato de prueba.
    soloEn: /^(packages\/database\/scripts|tools)\//,
    porQue: "un script que corre contra bases reales debe pedir la contraseña por variable de entorno",
  },
];

/** Línea exenta: `check-plaintext-credentials` (este archivo) o marcada a mano con el motivo. */
const EXENTA = /credencial-en-claro:permitido/;

const hallazgos = [];
for (const f of archivos()) {
  const abs = path.join(RAIZ, f);
  let texto;
  try {
    texto = fs.readFileSync(abs, "utf8");
  } catch {
    continue; // ilegible o borrado entre el ls-files y la lectura
  }
  if (texto.includes("\0")) continue; // binario
  const lineas = texto.split(/\r?\n/);
  for (const regla of reglas) {
    if (regla.soloEn && !regla.soloEn.test(f.replace(/\\/g, "/"))) continue;
    lineas.forEach((linea, i) => {
      if (EXENTA.test(linea)) return;
      if (!regla.re.test(linea)) return;
      if (regla.ademas && !regla.ademas.test(linea)) return;
      hallazgos.push({ f, linea: i + 1, regla, texto: linea.trim().slice(0, 120) });
    });
  }
}

if (hallazgos.length === 0) {
  console.log("✔ Sin credenciales en claro en los archivos rastreados.");
  process.exit(0);
}

console.error(`✖ ${hallazgos.length} credencial(es) en claro en el repo:\n`);
for (const h of hallazgos) {
  console.error(`  ${h.f}:${h.linea}  [${h.regla.id}]`);
  console.error(`    ${h.texto}`);
  console.error(`    → ${h.regla.porQue}\n`);
}
console.error(
  "Sacarla del archivo NO alcanza: lo que ya se publicó queda en el historial de git.\n" +
    "Hay que ROTAR o BORRAR la cuenta, y dejar el valor en una variable de entorno o en un gestor de contraseñas.\n",
);
process.exit(1);
