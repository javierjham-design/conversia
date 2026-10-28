import { describe, it, expect } from "vitest";
import {
  CONVI_NAME,
  INACTIVIDAD_MS,
  avisosProactivos,
  chipsSugeridos,
  debeAbrirseSolo,
  debeOfrecerAyuda,
  estadoDeConvi,
  saludoDeConvi,
  textoDeProgreso,
  type ConviCtx,
} from "./convi";

/**
 * COP 2 — las decisiones de Convi. Lo que importa acá no es la estética sino no volverse
 * una molestia: abrirse una sola vez, insistir solo cuando el dueño se quedó parado en un
 * paso pendiente, y avisar primero de lo que le cuesta plata.
 */
const base: ConviCtx = {
  mode: "implementacion",
  checklistPct: 0,
  blockingCompleted: 0,
  blockingTotal: 7,
  remainingMinutes: 21,
  nextStep: { key: "negocio", label: "Completa los datos de tu negocio", href: "/ajustes" },
  saldo: null,
  saldoRestante: null,
  saldoUnidad: null,
  lastChannelError: null,
  citasPorConfirmar: 0,
  businessName: "Barbería Central",
};

describe("la cara de Convi", () => {
  it("un error manda sobre todo lo demás: no puede estar celebrando si algo falló", () => {
    expect(estadoDeConvi({ error: true, celebrando: true, pensando: true })).toBe("preocupado");
  });

  it("mientras espera la respuesta está pensando, no hablando", () => {
    expect(estadoDeConvi({ pensando: true, conversacionEmpezada: true })).toBe("pensando");
  });

  it("celebra cuando se completó un paso", () => {
    expect(estadoDeConvi({ celebrando: true })).toBe("celebrando");
  });

  it("saluda al principio y habla cuando la conversación ya empezó", () => {
    expect(estadoDeConvi({})).toBe("saludando");
    expect(estadoDeConvi({ conversacionEmpezada: true })).toBe("hablando");
  });
});

describe("barra de progreso", () => {
  it('dice en qué paso va y cuánto falta: "Paso 3 de 7 · faltan ~12 min"', () => {
    expect(textoDeProgreso({ blockingCompleted: 2, blockingTotal: 7, remainingMinutes: 12 })).toBe("Paso 3 de 7 · faltan ~12 min");
  });

  it("no promete minutos si no hay estimación", () => {
    expect(textoDeProgreso({ blockingCompleted: 2, blockingTotal: 7, remainingMinutes: 0 })).toBe("Paso 3 de 7");
  });

  it("no se pasa del total en el último paso", () => {
    expect(textoDeProgreso({ blockingCompleted: 6, blockingTotal: 7, remainingMinutes: 2 })).toBe("Paso 7 de 7 · faltan ~2 min");
  });

  it("al terminar dice que está completo, no 'Paso 8 de 7'", () => {
    expect(textoDeProgreso({ blockingCompleted: 7, blockingTotal: 7, remainingMinutes: 0 })).toBe("Montaje completo ✔");
  });

  it("sin pasos cargados todavía, no inventa un número", () => {
    expect(textoDeProgreso({ blockingCompleted: 0, blockingTotal: 0, remainingMinutes: 0 })).toBe("Preparando tu montaje…");
  });
});

describe("saludo", () => {
  it("usa el nombre del negocio y propone el paso que sigue", () => {
    const s = saludoDeConvi(base);
    expect(s).toContain(CONVI_NAME);
    expect(s).toContain("Barbería Central");
    expect(s).toContain("**completa los datos de tu negocio**");
  });

  it('con el marcador "tu negocio" no lo trata como nombre propio', () => {
    // `buildContext` devuelve "tu negocio" cuando la organización no tiene nombre cargado.
    // Usarlo como nombre daría "el asistente de tu negocio", que suena a plantilla sin llenar.
    const s = saludoDeConvi({ ...base, businessName: "tu negocio" });
    expect(s).not.toMatch(/andando el asistente de/);
    expect(s).toContain("a dejar tu asistente andando");
  });

  it("en modo asistencia no propone pasos", () => {
    const s = saludoDeConvi({ ...base, mode: "asistencia", nextStep: null });
    expect(s).toContain("ya está atendiendo");
    expect(s).not.toContain("Lo que sigue");
  });
});

describe("chips dinámicos", () => {
  it("lo primero que ofrece es lo del paso pendiente", () => {
    const chips = chipsSugeridos(base);
    expect(chips[0]).toMatch(/datos de mi negocio/i);
  });

  it("cambian con el paso", () => {
    const wa = chipsSugeridos({ ...base, nextStep: { key: "whatsapp", label: "Conecta tu WhatsApp", href: "/canales" } });
    expect(wa[0]).toMatch(/WhatsApp/);
    expect(wa).not.toEqual(chipsSugeridos(base));
  });

  it('siempre deja la salida "¿Qué me falta?"', () => {
    expect(chipsSugeridos(base)).toContain("¿Qué me falta para activarlo?");
  });

  it("un paso sin chips propios no deja la lista vacía", () => {
    const chips = chipsSugeridos({ ...base, nextStep: { key: "mini_sitio", label: "Publica tu página", href: "/mini-sitio" } });
    expect(chips.length).toBeGreaterThan(0);
  });

  it("no muestra más de 3 (no es un menú)", () => {
    expect(chipsSugeridos(base).length).toBeLessThanOrEqual(3);
  });

  it("en modo asistencia ofrece lo de siempre, no pasos de montaje", () => {
    const chips = chipsSugeridos({ ...base, mode: "asistencia", nextStep: null });
    expect(chips).toContain("¿Cuánto saldo me queda?");
  });
});

describe("avisos proactivos (modo asistencia)", () => {
  const listo: ConviCtx = { ...base, mode: "asistencia", nextStep: null, checklistPct: 100, blockingCompleted: 7, remainingMinutes: 0 };

  it("sin nada que avisar, no avisa", () => {
    expect(avisosProactivos(listo)).toEqual([]);
  });

  it("saldo en cero: dice que el bot DEJÓ de responder, no que 'queda poco'", () => {
    const a = avisosProactivos({ ...listo, saldoRestante: 0, saldoUnidad: "conversation", saldo: "0 conversaciones disponibles" });
    expect(a[0].key).toBe("saldo-0");
    expect(a[0].urgente).toBe(true);
    expect(a[0].texto).toMatch(/dejó de responder/);
  });

  it("el umbral de saldo bajo es distinto por unidad (un crédito no es una conversación)", () => {
    const conv = avisosProactivos({ ...listo, saldoRestante: 50, saldoUnidad: "conversation", saldo: "50 conversaciones disponibles" });
    const cred = avisosProactivos({ ...listo, saldoRestante: 50, saldoUnidad: "credit", saldo: "50 créditos disponibles" });
    expect(conv).toEqual([]); // 50 conversaciones todavía alcanzan
    expect(cred[0]?.key).toBe("saldo-bajo"); // 50 créditos se van en unas pocas respuestas
  });

  it("el umbral se calcula sobre el NÚMERO, no sobre la frase", () => {
    // Sin número no hay aviso, aunque la frase diga algo alarmante.
    expect(avisosProactivos({ ...listo, saldo: "0 conversaciones disponibles", saldoRestante: null })).toEqual([]);
  });

  it("avisa del canal caído", () => {
    const a = avisosProactivos({ ...listo, lastChannelError: "Meta rechazó el envío" });
    expect(a[0].key).toBe("canal");
    expect(a[0].urgente).toBe(true);
    // No le muestra el error técnico al dueño.
    expect(a[0].texto).not.toContain("Meta rechazó el envío");
  });

  it("avisa de las citas por confirmar, en singular y plural", () => {
    expect(avisosProactivos({ ...listo, citasPorConfirmar: 1 })[0].texto).toMatch(/1 cita por confirmar/);
    expect(avisosProactivos({ ...listo, citasPorConfirmar: 3 })[0].texto).toMatch(/3 citas por confirmar/);
  });

  it("ordena por lo que le cuesta plata: saldo, canal, citas", () => {
    const a = avisosProactivos({ ...listo, saldoRestante: 0, saldoUnidad: "credit", saldo: "0", lastChannelError: "x", citasPorConfirmar: 2 });
    expect(a.map((x) => x.key)).toEqual(["saldo-0", "canal", "citas"]);
  });
});

describe("cuándo se abre solo", () => {
  it("en modo montaje, la primera vez de la sesión", () => {
    expect(debeAbrirseSolo({ mode: "implementacion", yaSeAbrioEnLaSesion: false, loCerroElDueno: false })).toBe(true);
  });

  it("NO se abre de nuevo en la misma sesión (un panel que se abre en cada navegación molesta)", () => {
    expect(debeAbrirseSolo({ mode: "implementacion", yaSeAbrioEnLaSesion: true, loCerroElDueno: false })).toBe(false);
  });

  it("si el dueño lo cerró, se respeta", () => {
    expect(debeAbrirseSolo({ mode: "implementacion", yaSeAbrioEnLaSesion: false, loCerroElDueno: true })).toBe(false);
  });

  it("con el montaje terminado NO se abre solo: ahí es un acceso discreto", () => {
    expect(debeAbrirseSolo({ mode: "asistencia", yaSeAbrioEnLaSesion: false, loCerroElDueno: false })).toBe(false);
  });
});

describe("cuándo vuelve a ofrecer ayuda", () => {
  const quieto = { mode: "implementacion", abierto: false, msQuieto: INACTIVIDAD_MS, pasoPendienteKey: "negocio", yaOfrecidoParaPaso: null as string | null };

  it("cuando la pantalla queda quieta en un paso pendiente", () => {
    expect(debeOfrecerAyuda(quieto)).toBe(true);
  });

  it("no antes de tiempo", () => {
    expect(debeOfrecerAyuda({ ...quieto, msQuieto: INACTIVIDAD_MS - 1 })).toBe(false);
  });

  it("no si ya está abierto", () => {
    expect(debeOfrecerAyuda({ ...quieto, abierto: true })).toBe(false);
  });

  it("no insiste dos veces por el MISMO paso", () => {
    expect(debeOfrecerAyuda({ ...quieto, yaOfrecidoParaPaso: "negocio" })).toBe(false);
  });

  it("pero sí vuelve a ofrecer cuando el dueño avanzó al paso siguiente", () => {
    expect(debeOfrecerAyuda({ ...quieto, pasoPendienteKey: "servicios", yaOfrecidoParaPaso: "negocio" })).toBe(true);
  });

  it("no molesta si no falta nada", () => {
    expect(debeOfrecerAyuda({ ...quieto, pasoPendienteKey: null })).toBe(false);
    expect(debeOfrecerAyuda({ ...quieto, mode: "asistencia" })).toBe(false);
  });
});
