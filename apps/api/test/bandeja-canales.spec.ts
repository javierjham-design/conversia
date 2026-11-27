import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ConversationsController, buildViewWhere } from "../src/conversations/conversations.controller";
import { REDES_BANDEJA, idsDeLaRed, redDelTipo, tipoDeRed } from "../src/conversations/canales-filtro";
import { runWithContext, type RequestContext } from "../src/tenancy/context";

/**
 * SEPARAR LA BANDEJA POR RED (WhatsApp / Instagram / Messenger / TikTok) — y verlas juntas.
 *
 * La falla que importa no es que el filtro no filtre: es que filtre de MENOS. Pedir
 * «Instagram» y recibir además las conversaciones de WhatsApp parece que funcionó —la lista
 * trae cosas— y hace perder clientes, porque uno cree estar mirando una red y está mirando
 * otra. Los tres caminos por los que eso puede pasar:
 *
 *  1. Una clave desconocida tratada como «sin filtro» → devuelve TODO.
 *  2. Una red sin conexiones tratada como «sin filtro» → devuelve TODO.
 *  3. Una vista guardada por red cuyos ids nadie resolvió → el filtro se evapora.
 *
 * Por eso acá no se prueba solo la función pura: se ejecuta `list()` contra una base de
 * mentira que EVALÚA el where de verdad y revienta ante cualquier cláusula que no entienda
 * (un evaluador permisivo daría verde ignorando justo la condición que se quiere probar).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base de mentira que evalúa el `where`
// ─────────────────────────────────────────────────────────────────────────────

/** Evalúa el subconjunto de where que produce `list()`. Lo que no entiende, lo DENUNCIA. */
function cumple(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [campo, cond] of Object.entries(where)) {
    if (campo === "AND") {
      if (!(cond as Record<string, unknown>[]).every((w) => cumple(row, w))) return false;
      continue;
    }
    const valor = row[campo];
    if (cond && typeof cond === "object") {
      const ops = Object.keys(cond as object);
      if (ops.length === 1 && ops[0] === "in") {
        if (!(cond as { in: unknown[] }).in.includes(valor)) return false;
        continue;
      }
      if (ops.length === 1 && ops[0] === "gt") {
        if (!(typeof valor === "number" && valor > (cond as { gt: number }).gt)) return false;
        continue;
      }
      throw new Error(`el evaluador no entiende ${campo}=${JSON.stringify(cond)} — el test no probaría nada`);
    }
    if (valor !== cond) return false;
  }
  return true;
}

const CONEXIONES = [
  { id: "wa1", type: "WHATSAPP_CLOUD" },
  { id: "wa2", type: "WHATSAPP_CLOUD" }, // dos números: «todo WhatsApp» tiene que traer los dos
  { id: "ig1", type: "INSTAGRAM" },
];

const CONVERSACIONES = [
  { id: "c-wa1", channelConnectionId: "wa1", contactId: "k1", status: "OPEN", unreadCount: 0 },
  { id: "c-wa2", channelConnectionId: "wa2", contactId: "k2", status: "OPEN", unreadCount: 0 },
  { id: "c-ig", channelConnectionId: "ig1", contactId: "k3", status: "OPEN", unreadCount: 0 },
  // Sin canal: existe de verdad (conversaciones creadas antes de tener canal, o cuyo canal
  // se borró). Tiene que salir en «todas juntas» y en NINGUNA red concreta.
  { id: "c-huerfana", channelConnectionId: null, contactId: "k4", status: "OPEN", unreadCount: 0 },
];

function makePrisma(vista?: { id: string; definition: Record<string, unknown> }) {
  const wheres: Record<string, unknown>[] = [];
  const tx = {
    inboxView: { findUnique: async ({ where }: any) => (vista && vista.id === where.id ? vista : null) },
    channelConnection: { findMany: async () => CONEXIONES },
    conversation: {
      findMany: async ({ where }: any) => {
        wheres.push(where);
        return CONVERSACIONES.filter((c) => cumple(c as any, where)).map((c) => ({
          ...c,
          aiEnabled: true,
          assignedUserId: null,
          assignedTeamId: null,
          activeAgentId: null,
          lastMessagePreview: null,
          lastMessageAt: null,
          contact: {
            id: c.contactId,
            firstName: "A",
            lastName: null,
            profileName: null,
            phone: "1",
            country: null,
            blocked: false,
            ctwaClid: null,
            adId: null,
            attributes: null,
          },
        }));
      },
    },
    tag: { findMany: async () => [] },
    tagAssignment: { findMany: async () => [] },
    organizationUser: { findMany: async () => [] },
    team: { findMany: async () => [] },
    agent: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  const prisma: any = { withTenant: (_org: string, fn: any) => fn(tx), admin: {} };
  return { prisma, wheres };
}

const ctx: RequestContext = { userId: "u1", organizationId: "org1", roleCode: "owner", permissions: ["inbox:read"] };

const controlador = (prisma: any) => new ConversationsController(prisma, {} as any, {} as any);

/**
 * `list()` recibe los filtros como parámetros POSICIONALES. Llamarlos a mano es frágil, así
 * que el orden se verifica en un test aparte; si alguien mete un @Query nuevo en medio, ese
 * test cae en vez de dejar que todos estos prueben otra cosa.
 */
function listar(c: ConversationsController, p: { channel?: string; view?: string } = {}) {
  return runWithContext(ctx, () =>
    c.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, p.channel, p.view),
  ) as Promise<{ items: { id: string }[] }>;
}

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Separar y ver juntas — contra la base de mentira
// ─────────────────────────────────────────────────────────────────────────────
describe("la bandeja se separa por red y se puede ver todo junto", () => {
  it("sin filtro salen TODAS juntas, incluida la que no tiene canal", async () => {
    const { prisma } = makePrisma();
    expect(ids(await listar(controlador(prisma)))).toEqual(["c-huerfana", "c-ig", "c-wa1", "c-wa2"]);
  });

  it("«Instagram» trae SOLO Instagram: ni una de WhatsApp", async () => {
    const { prisma } = makePrisma();
    expect(ids(await listar(controlador(prisma), { channel: "instagram" }))).toEqual(["c-ig"]);
  });

  it("«WhatsApp» junta los DOS números (es el punto: la red, no la conexión)", async () => {
    const { prisma } = makePrisma();
    expect(ids(await listar(controlador(prisma), { channel: "whatsapp" }))).toEqual(["c-wa1", "c-wa2"]);
  });

  it("una conversación SIN canal no se cuela en ninguna red", async () => {
    const { prisma } = makePrisma();
    for (const channel of ["whatsapp", "instagram"]) {
      const r = await listar(controlador(prisma), { channel });
      expect(ids(r), `«${channel}» incluyó la conversación huérfana`).not.toContain("c-huerfana");
    }
  });

  it("una red SIN conexiones (TikTok hoy) devuelve CERO, no todo", async () => {
    // TikTok figura en el catálogo aunque el canal de DM no exista todavía (docs/TIKTOK.md
    // §2). El riesgo es que «no hay conexiones» se interprete como «no filtres».
    const { prisma } = makePrisma();
    expect((await listar(controlador(prisma), { channel: "tiktok" })).items).toEqual([]);
  });

  it("una clave desconocida es un 400, NO «todas»", async () => {
    const { prisma } = makePrisma();
    await expect(listar(controlador(prisma), { channel: "whatsap" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("una bandeja guardada por red filtra de verdad (sus ids se resuelven)", async () => {
    const { prisma } = makePrisma({ id: "v1", definition: { channelType: "instagram", status: "all" } });
    expect(ids(await listar(controlador(prisma), { view: "v1" }))).toEqual(["c-ig"]);
  });

  it("red del chip + conexión fija de la vista se SUMAN (no se pisan)", async () => {
    // Vista clavada en el número wa1 + chip «Instagram» = nada. Es lo correcto: si una
    // ganara a la otra, la pantalla mostraría conversaciones que no cumplen lo que se pidió.
    const vista = { id: "v2", definition: { channelId: "wa1", status: "all" } };
    expect((await listar(controlador(makePrisma(vista).prisma), { view: "v2", channel: "instagram" })).items).toEqual([]);
    const soloVista = await listar(controlador(makePrisma(vista).prisma), { view: "v2" });
    expect(ids(soloVista), "la vista sola sí tiene que traer wa1").toEqual(["c-wa1"]);
  });

  it("el parámetro 10 de list() sigue siendo `channel`", () => {
    // Los tests de arriba llaman a `list()` por POSICIÓN. Si alguien agrega un @Query antes,
    // seguirían en verde probando otra cosa.
    const src = readFileSync(join(__dirname, "..", "src", "conversations", "conversations.controller.ts"), "utf8");
    const firma = /async list\(([\s\S]*?)\n  \) \{/.exec(src)?.[1] ?? "";
    const nombres = [...firma.matchAll(/@Query\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(nombres.length, "no se pudo leer la firma de list()").toBeGreaterThan(5);
    expect(nombres[9]).toBe("channel");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. El catálogo de redes
// ─────────────────────────────────────────────────────────────────────────────
describe("catálogo de redes", () => {
  it("una clave que no existe devuelve null (≠ lista vacía): es la señal del 400", () => {
    expect(idsDeLaRed("telegram", CONEXIONES)).toBeNull();
    expect(tipoDeRed("telegram")).toBeNull();
  });

  it("una red real sin conexiones devuelve [] (cero conversaciones, no «sin filtro»)", () => {
    expect(idsDeLaRed("tiktok", CONEXIONES)).toEqual([]);
    expect(idsDeLaRed("messenger", CONEXIONES)).toEqual([]);
  });

  it("TikTok está en el catálogo y NO necesita que el enum de la base lo conozca", () => {
    // Clave: el tipo nunca se le manda a Postgres; se compara en memoria contra las
    // conexiones que ya vinieron. Por eso TikTok puede figurar antes de que exista el canal
    // (lo bloquea la revisión DSPR) sin reventar con un valor que el enum no tiene.
    expect(REDES_BANDEJA.map((r) => r.clave)).toContain("tiktok");
    expect(() => idsDeLaRed("tiktok", CONEXIONES)).not.toThrow();
  });

  it("claves y tipos son únicos y se traducen en los dos sentidos", () => {
    expect(new Set(REDES_BANDEJA.map((r) => r.clave)).size).toBe(REDES_BANDEJA.length);
    expect(new Set(REDES_BANDEJA.map((r) => r.tipo)).size).toBe(REDES_BANDEJA.length);
    for (const r of REDES_BANDEJA) expect(redDelTipo(r.tipo)).toBe(r.clave);
  });

  it("los DOS paneles traen el MISMO catálogo que el servidor", () => {
    // Las claves viajan en `?channel=…`. Si un panel se queda con una clave vieja, su chip
    // deja de traer nada (o peor: un 400) y nadie lo nota hasta que un cliente lo toca.
    const mio = REDES_BANDEJA.map((r) => `${r.clave}:${r.tipo}`);
    for (const panel of ["web", "conversia-web"]) {
      const src = readFileSync(join(__dirname, "..", "..", panel, "src", "lib", "redes.ts"), "utf8");
      const suyo = [...src.matchAll(/\{ clave: "([a-z]+)", tipo: "([A-Z_]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
      expect(suyo.length, `no se pudo leer REDES_BANDEJA de apps/${panel}`).toBe(mio.length);
      expect(suyo, `apps/${panel} tiene otro catálogo de redes que el servidor`).toEqual(mio);
    }
  });

  it("todo tipo del enum ChannelType tiene su red (si no, esas conversaciones no se pueden separar)", () => {
    const schema = readFileSync(join(__dirname, "..", "..", "..", "packages", "database", "prisma", "schema.prisma"), "utf8");
    const bloque = /enum ChannelType \{([^}]+)\}/.exec(schema)?.[1] ?? "";
    const tipos = bloque.split("\n").map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l));
    expect(tipos.length, "no se pudo leer el enum ChannelType").toBeGreaterThan(2);
    expect(tipos.filter((t) => !redDelTipo(t)), "tipos de canal sin red en el catálogo").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. La vista guardada: el filtro no puede evaporarse
// ─────────────────────────────────────────────────────────────────────────────
describe("buildViewWhere con red", () => {
  it("si nadie resolvió los ids, filtra por lista VACÍA — nunca borra el filtro", () => {
    const w = buildViewWhere({ channelType: "whatsapp" }, "u1") as { AND?: unknown[] };
    expect(w.AND, "el filtro por red desapareció: la vista mostraría las otras redes").toEqual([
      { channelConnectionId: { in: [] } },
    ]);
  });

  it("conexión concreta y red conviven en el AND", () => {
    const w = buildViewWhere({ channelId: "wa1", channelType: "whatsapp" }, "u1", undefined, ["wa1", "wa2"]) as {
      AND?: unknown[];
    };
    expect(w.AND).toEqual([{ channelConnectionId: "wa1" }, { channelConnectionId: { in: ["wa1", "wa2"] } }]);
  });

  it("sin canal no aparece ningún AND (no se cambia el where de nadie más)", () => {
    expect(buildViewWhere({ status: "open" }, "u1")).not.toHaveProperty("AND");
  });
});
