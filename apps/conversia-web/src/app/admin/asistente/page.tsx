"use client";
import { useCallback, useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Super admin — **Convi (copiloto)**: proveedor y modelo del asistente del panel.
 *
 * Por qué existe esta pantalla. Convi estuvo caído varios días con las API keys perfectamente
 * cargadas: su proveedor y su modelo vivían SOLO en variables de entorno del servicio `api`,
 * no se podían ver desde ninguna parte, y cambiarlos exigía entrar a Railway y reiniciar el
 * servicio. El dueño no tenía ni diagnóstico ni arreglo. Acá se ve lo que Convi usa de
 * verdad, se cambia sin desplegar, y —lo más importante— se PRUEBA antes de guardar.
 *
 * Las API keys NO se editan desde acá y nunca se muestran: son secretos del servicio. Lo
 * único que la pantalla sabe es qué proveedores TIENEN llave, para no ofrecer uno que daría
 * un 401 seguro.
 */

interface Opcion { model: string; level: string; creditsPerReply: number; selfServe: boolean }
interface Efectiva {
  provider: string;
  model: string;
  modelPedido: string;
  fallbackModel?: string;
  origen: { provider: "consola" | "entorno"; model: "consola" | "entorno" };
}
interface Guardada { provider: "anthropic" | "openai" | "mock" | null; model: string; fallbackModel: string }
interface Estado {
  guardada: Guardada;
  efectiva: Efectiva;
  proveedoresDisponibles: ("anthropic" | "openai" | "mock")[];
  opciones: Opcion[];
  cacheSegundos: number;
}
interface Prueba { ok: boolean; provider: string; model: string; modelPedido: string; ms?: number; reply?: string; detail?: string }

type Status = { kind: "ok" | "error"; text: string } | null;

const errMsg = (e: unknown) => (e instanceof PlatformApiError ? e.message : (e as Error).message);

const field: React.CSSProperties = {
  width: "100%",
  maxWidth: 320,
  padding: "10px 12px",
  marginTop: 5,
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--surface-solid)",
  color: "var(--ink)",
  fontSize: 14,
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block" };

/** Nombre humano del proveedor: "anthropic" no le dice nada a nadie fuera del código. */
const NOMBRE: Record<string, string> = { anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)", mock: "Simulación (mock)" };

/** Familia a la que pertenece un modelo, para no ofrecer cruces que el servidor va a reescribir. */
function familia(model: string): "anthropic" | "openai" | null {
  if (/^claude/i.test(model)) return "anthropic";
  if (/^(gpt-|o[1-9]|chatgpt)/i.test(model)) return "openai";
  return null;
}

export default function AsistentePage() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [provider, setProvider] = useState<"anthropic" | "openai" | "">("");
  const [model, setModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [prueba, setPrueba] = useState<Prueba | null>(null);
  const [probando, setProbando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const e = await padmin<Estado>("/assistant/config");
      setEstado(e);
      setProvider(e.guardada.provider === "mock" ? "" : (e.guardada.provider ?? ""));
      setModel(e.guardada.model);
      setFallbackModel(e.guardada.fallbackModel);
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // El proveedor elegido manda sobre qué modelos tiene sentido ofrecer. Si no hay proveedor
  // elegido, se usa el efectivo (el del entorno) para no mostrar una lista que no aplica.
  const proveedorVigente = provider || estado?.efectiva.provider || "";
  const modelosDeLaFamilia = (estado?.opciones ?? []).filter((o) => {
    const f = familia(o.model);
    return !f || f === proveedorVigente;
  });

  async function probar() {
    setProbando(true);
    setPrueba(null);
    setStatus(null);
    try {
      const r = await padmin<Prueba>("/assistant/test", {
        method: "POST",
        body: JSON.stringify({ provider: provider || null, model }),
      });
      setPrueba(r);
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setProbando(false);
    }
  }

  async function guardar() {
    setGuardando(true);
    setStatus(null);
    try {
      await padmin("/assistant/config", {
        method: "PUT",
        body: JSON.stringify({ provider: provider || null, model, fallbackModel }),
      });
      await cargar();
      setStatus({
        kind: "ok",
        text: `Guardado. Puede tardar hasta ${estado?.cacheSegundos ?? 60} segundos en aplicarse en todas las instancias.`,
      });
    } catch (e) {
      setStatus({ kind: "error", text: errMsg(e) });
    } finally {
      setGuardando(false);
    }
  }

  const sinLlaves = estado !== null && estado.proveedoresDisponibles.length === 0;

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>Convi (copiloto)</h1>
      <p className="text-dim" style={{ margin: "0 0 20px", fontSize: 13 }}>
        Proveedor y modelo del asistente del panel. Lo paga Conversia, no el cliente: no se debita
        de los Créditos IA de nadie. El modelo de los bots de tus clientes se configura en la ficha
        de cada agente, no acá.
      </p>

      {/* LO QUE CONVI USA DE VERDAD. Primero, porque es la pregunta que no se podía responder. */}
      <section className="card" style={{ padding: 18, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Ahora mismo</h2>
        {!estado ? (
          <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Cargando…</p>
        ) : (
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", margin: 0, fontSize: 13.5 }}>
            <dt className="text-dim">Proveedor</dt>
            <dd style={{ margin: 0 }}>
              {NOMBRE[estado.efectiva.provider] ?? estado.efectiva.provider}{" "}
              <span className="text-dim" style={{ fontSize: 12 }}>
                ({estado.efectiva.origen.provider === "consola" ? "elegido acá" : "de las variables del servicio"})
              </span>
            </dd>
            <dt className="text-dim">Modelo</dt>
            <dd style={{ margin: 0 }}>
              <code>{estado.efectiva.model}</code>{" "}
              <span className="text-dim" style={{ fontSize: 12 }}>
                ({estado.efectiva.origen.model === "consola" ? "elegido acá" : "de las variables del servicio"})
              </span>
            </dd>
            <dt className="text-dim">Respaldo</dt>
            <dd style={{ margin: 0 }}>
              {estado.efectiva.fallbackModel ? (
                <code>{estado.efectiva.fallbackModel}</code>
              ) : (
                <span style={{ color: "var(--danger)" }}>sin respaldo — si el modelo falla, Convi se cae</span>
              )}
            </dd>
            <dt className="text-dim">Llaves cargadas</dt>
            <dd style={{ margin: 0 }}>
              {estado.proveedoresDisponibles.length
                ? estado.proveedoresDisponibles.map((p) => NOMBRE[p] ?? p).join(" · ")
                : "ninguna"}
            </dd>
          </dl>
        )}
        {/* El caso que pasó: el modelo pedido se descarta por no ser de la familia del proveedor. */}
        {estado && estado.efectiva.modelPedido && estado.efectiva.modelPedido !== estado.efectiva.model ? (
          <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--danger)" }}>
            El modelo <code>{estado.efectiva.modelPedido}</code> está configurado pero <strong>no se usa</strong>:
            no es de la familia de {NOMBRE[estado.efectiva.provider] ?? estado.efectiva.provider}, así que Convi va
            con <code>{estado.efectiva.model}</code>. Para usarlo, elige el proveedor que le corresponde.
          </p>
        ) : null}
      </section>

      {sinLlaves ? (
        <section className="card" style={{ padding: 18, marginBottom: 16, borderColor: "var(--danger)" }}>
          <h2 style={{ fontSize: 16, margin: "0 0 6px", color: "var(--danger)" }}>No hay ninguna API key cargada</h2>
          <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>
            Sin <code>ANTHROPIC_API_KEY</code> u <code>OPENAI_API_KEY</code> en el servicio <strong>api</strong>,
            Convi responde con el proveedor de simulación. Las keys se cargan en Railway (son secretos del
            servicio y no se editan desde el panel); después vuelve a esta pantalla y elige el proveedor.
          </p>
        </section>
      ) : null}

      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 4px" }}>Cambiar</h2>
        <p className="text-dim" style={{ margin: "0 0 16px", fontSize: 13 }}>
          Prueba antes de guardar: la prueba hace una llamada real y te muestra el error del proveedor
          si algo está mal (una llave vencida o un modelo retirado).
        </p>

        <div style={{ display: "grid", gap: 14, maxWidth: 340 }}>
          <label style={labelStyle}>
            Proveedor
            <select
              value={provider}
              onChange={(e) => {
                const p = e.target.value as "anthropic" | "openai" | "";
                setProvider(p);
                // Cambiar de proveedor invalida un modelo de la otra familia: en vez de
                // guardarlo para que el servidor lo descarte en silencio, se limpia acá.
                if (model && p && familia(model) && familia(model) !== p) setModel("");
                if (fallbackModel && p && familia(fallbackModel) && familia(fallbackModel) !== p) setFallbackModel("");
                setPrueba(null);
              }}
              style={field}
            >
              <option value="">Usar el de las variables del servicio</option>
              {(estado?.proveedoresDisponibles ?? [])
                .filter((p) => p !== "mock")
                .map((p) => (
                  <option key={p} value={p}>{NOMBRE[p] ?? p}</option>
                ))}
            </select>
          </label>

          <label style={labelStyle}>
            Modelo
            <select value={model} onChange={(e) => { setModel(e.target.value); setPrueba(null); }} style={field}>
              <option value="">Usar el default del proveedor</option>
              {modelosDeLaFamilia.map((o) => (
                <option key={o.model} value={o.model}>
                  {o.model} · {o.level}
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Modelo de respaldo
            <select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} style={field}>
              <option value="">Usar el de las variables del servicio</option>
              {modelosDeLaFamilia.filter((o) => o.model !== model).map((o) => (
                <option key={o.model} value={o.model}>
                  {o.model} · {o.level}
                </option>
              ))}
            </select>
          </label>
          <p className="text-dim" style={{ margin: 0, fontSize: 12 }}>
            El respaldo se usa si el modelo principal falla todos sus intentos. Conviene que sea de la
            misma familia y más barato: sin respaldo, un modelo caído deja a Convi caído.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <button onClick={() => void probar()} disabled={probando || !estado} className="card" style={{ cursor: "pointer", padding: "9px 16px", fontSize: 13.5 }}>
            {probando ? "Probando…" : "Probar"}
          </button>
          <button onClick={() => void guardar()} disabled={guardando || !estado} className="btn-accent" style={{ border: "none", cursor: "pointer", padding: "9px 16px", fontSize: 13.5 }}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>

        {prueba ? (
          <div
            className="card"
            style={{ marginTop: 16, padding: 14, borderColor: prueba.ok ? "var(--ok)" : "var(--danger)" }}
          >
            <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: prueba.ok ? "var(--ok)" : "var(--danger)" }}>
              {prueba.ok ? `Responde bien (${prueba.ms} ms)` : "No responde"}
            </p>
            <p className="text-dim" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              {NOMBRE[prueba.provider] ?? prueba.provider} · <code>{prueba.model}</code>
              {prueba.modelPedido && prueba.modelPedido !== prueba.model ? (
                <> · se pidió <code>{prueba.modelPedido}</code> y se reescribió por familia</>
              ) : null}
            </p>
            {prueba.detail ? (
              <p style={{ margin: "8px 0 0", fontSize: 12.5, wordBreak: "break-word" }}>{prueba.detail}</p>
            ) : null}
          </div>
        ) : null}

        {status ? (
          <p style={{ margin: "14px 0 0", fontSize: 13, color: status.kind === "ok" ? "var(--ok)" : "var(--danger)" }}>
            {status.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}
