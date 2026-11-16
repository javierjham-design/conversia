import { decidirEscalamiento } from "../../src/assistant/escalamiento";
import { porQueNoRespondio, type EntradaDelDiagnostico } from "../../src/assistant/diagnostico-conversacion";
import { diagnosticarCuenta, type CuentaEntrada } from "../../src/assistant/setup-logic";

/**
 * ARNÉS DE CALIDAD DE CONVI — E5.
 *
 * Qué prueba y qué NO. Esto no evalúa al modelo: evalúa **las reglas con las que el modelo
 * tiene que jugar**. Un test que mande el escenario a la IA de verdad sería caro, lento y —lo
 * peor— no determinista: fallaría en días distintos sin que nadie haya cambiado una línea, y
 * un test que falla al azar se termina ignorando.
 *
 * Lo que sí se prueba, y es lo que importa: dado el estado de una cuenta, ¿qué DEBE hacer
 * Convi? ¿Qué herramienta corresponde? ¿Escala o no? ¿Qué frases tiene prohibidas? Esas son
 * decisiones nuestras, están en código, y si alguien las cambia sin querer, acá se cae.
 *
 * Con `CONVI_ARNES_LIVE=1` se puede además correr contra el modelo real (nocturno), pero eso
 * es una comprobación extra, no el guardián.
 */

/** Frases que Convi NO puede decir nunca. Cada una está acá por un caso real. */
export const FRASES_PROHIBIDAS: Array<{ patron: RegExp; porque: string }> = [
  {
    patron: /he informado tu caso al equipo/i,
    porque: "Lo decía ante una cuenta vencida, que se resuelve pagando — y además no avisaba a nadie (E4).",
  },
  {
    patron: /no puedo probar el asistente/i,
    porque: "Era un defecto: la prueba usaba la regla vieja de vigencia (E2.a).",
  },
  {
    patron: /\[(image|audio|video|sticker|document|location|contacts)\]/i,
    porque: "Los placeholders en inglés y entre corchetes eran una marca de depuración que llegó al producto.",
  },
  {
    patron: /no puedo ayudarte con eso/i,
    porque: "Un «no puedo» a secas deja al dueño sin salida. Si falta permiso, se pide autorización.",
  },
  {
    patron: /tuve un (problema|inconveniente)/i,
    porque: "Sin el dato concreto no se puede hacer nada con esa frase.",
  },
];

export interface Escenario {
  nombre: string;
  /** Lo que escribe el dueño. Documenta el caso; las aserciones van sobre las reglas. */
  mensaje: string;
  cuenta?: CuentaEntrada;
  conversacion?: EntradaDelDiagnostico;
  /** El motivo con el que Convi intentaría escalar, si lo intentara. */
  intentaEscalarCon?: { motivo: string; consultado: string[] };
  espera: {
    /** Qué herramienta tiene que ofrecer la regla. */
    herramienta?: string | null;
    /** ¿Debe quedar bloqueado para crear cosas? */
    puedeCrear?: boolean;
    /** ¿El bloqueo lo resuelve el equipo? */
    loResuelveElEquipo?: boolean;
    /** La causa del silencio del bot. */
    causa?: string;
    /** ¿Corresponde escalar? */
    escala?: boolean;
  };
}

export interface ResultadoDelEscenario {
  nombre: string;
  ok: boolean;
  fallos: string[];
}

/** Corre un escenario contra las reglas y devuelve qué falló, si algo falló. */
export function correrEscenario(e: Escenario): ResultadoDelEscenario {
  const fallos: string[] = [];

  if (e.cuenta) {
    const d = diagnosticarCuenta(e.cuenta);
    if (e.espera.puedeCrear !== undefined && d.puedeCrear !== e.espera.puedeCrear) {
      fallos.push(`puedeCrear: esperaba ${e.espera.puedeCrear} y fue ${d.puedeCrear}`);
    }
    if (e.espera.loResuelveElEquipo !== undefined) {
      const real = d.bloqueos.some((b) => b.loResuelveElEquipo);
      if (real !== e.espera.loResuelveElEquipo) {
        fallos.push(`loResuelveElEquipo: esperaba ${e.espera.loResuelveElEquipo} y fue ${real}`);
      }
    }
    for (const b of d.bloqueos) {
      for (const f of FRASES_PROHIBIDAS) {
        if (f.patron.test(`${b.que} ${b.porque} ${b.comoSeArregla ?? ""}`)) {
          fallos.push(`frase prohibida en el bloqueo (${f.porque})`);
        }
      }
    }
  }

  if (e.conversacion) {
    const d = porQueNoRespondio(e.conversacion);
    if (e.espera.causa && d.causa !== e.espera.causa) {
      fallos.push(`causa: esperaba ${e.espera.causa} y fue ${d.causa}`);
    }
    if (e.espera.herramienta !== undefined && d.herramienta !== e.espera.herramienta) {
      fallos.push(`herramienta: esperaba ${e.espera.herramienta} y fue ${d.herramienta}`);
    }
    for (const f of FRASES_PROHIBIDAS) {
      if (f.patron.test(`${d.que} ${d.comoSeArregla ?? ""}`)) {
        fallos.push(`frase prohibida en el diagnóstico (${f.porque})`);
      }
    }
  }

  if (e.intentaEscalarCon) {
    const d = decidirEscalamiento(e.intentaEscalarCon);
    if (e.espera.escala !== undefined && d.escala !== e.espera.escala) {
      fallos.push(`escala: esperaba ${e.espera.escala} y fue ${d.escala}`);
    }
  }

  return { nombre: e.nombre, ok: fallos.length === 0, fallos };
}

/** Métrica que mira el dueño: cuántos escenarios terminan escalando. */
export function tasaDeEscalamiento(escenarios: Escenario[]): number {
  const conIntento = escenarios.filter((e) => e.intentaEscalarCon);
  if (!conIntento.length) return 0;
  const escalan = conIntento.filter((e) => decidirEscalamiento(e.intentaEscalarCon!).escala);
  return Math.round((escalan.length / conIntento.length) * 100);
}
