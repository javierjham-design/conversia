"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * COP 1 — "Tu negocio" en /ajustes: nombre, rubro, dirección y HORARIO DE ATENCIÓN.
 *
 * Es el paso bloqueante nº1 del montaje y hasta ahora no existía en el panel: `/ajustes`
 * solo tenía los datos personales del usuario (nombre, tema, avisos), así que el checklist
 * mandaba a esta pantalla a completar algo que no se podía completar aquí. Era el pendiente
 * anotado en la fila 3 del plan.
 *
 * El horario se edita como LISTA de tramos por día (no un solo rango) a propósito: la
 * organización guarda hasta 4 por día y el copiloto los usa para los negocios que cierran a
 * mediodía. Un formulario de un solo rango habría borrado el segundo tramo en silencio cada
 * vez que el dueño guardara.
 */

type Tramo = { from: string; to: string };
type Hours = Record<string, Tramo[]>;

const DIAS: { key: string; label: string; corto: string }[] = [
  { key: "mon", label: "Lunes", corto: "lun" },
  { key: "tue", label: "Martes", corto: "mar" },
  { key: "wed", label: "Miércoles", corto: "mié" },
  { key: "thu", label: "Jueves", corto: "jue" },
  { key: "fri", label: "Viernes", corto: "vie" },
  { key: "sat", label: "Sábado", corto: "sáb" },
  { key: "sun", label: "Domingo", corto: "dom" },
];

const LABORALES = ["mon", "tue", "wed", "thu", "fri"];

type Negocio = { nombre: string; rubro: string; direccion: string; descripcion: string; rubros: { code: string; label: string }[] };

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 13px",
  marginTop: 6,
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--surface-solid)",
  color: "var(--ink)",
  fontSize: 14,
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block" };

export function BusinessSettings() {
  const [negocio, setNegocio] = useState<Negocio | null>(null);
  const [nombre, setNombre] = useState("");
  const [rubro, setRubro] = useState("");
  const [direccion, setDireccion] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [hours, setHours] = useState<Hours>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * ¿El dueño ya empezó a editar? Las dos cargas son asíncronas y el horario tarda más (es
   * otra clave de configuración). Sin este candado, alguien con conexión lenta que empieza a
   * marcar días PIERDE lo marcado cuando llega la respuesta, porque `setHours` la pisa.
   * Lo cazó la jornada H en CI, donde el tecleo es inmediato y la respuesta no.
   */
  const tocado = useRef(false);

  useEffect(() => {
    api<Negocio>("/settings/business")
      .then((n) => {
        setNegocio(n);
        if (tocado.current) return;
        setNombre(n.nombre);
        setRubro(n.rubro);
        setDireccion(n.direccion);
        setDescripcion(n.descripcion);
      })
      .catch((e) => setError((e as Error).message));
    api<{ hours: Hours }>("/settings/hours")
      .then((h) => {
        if (tocado.current) return;
        setHours(h.hours ?? {});
      })
      .catch(() => undefined);
  }, []);

  function abrir(dia: string) {
    tocado.current = true;
    setHours((h) => ({ ...h, [dia]: [{ from: "09:00", to: "18:00" }] }));
  }
  function cerrar(dia: string) {
    tocado.current = true;
    setHours((h) => {
      const next = { ...h };
      delete next[dia];
      return next;
    });
  }
  function agregarTramo(dia: string) {
    tocado.current = true;
    setHours((h) => ({ ...h, [dia]: [...(h[dia] ?? []), { from: "09:00", to: "13:00" }].slice(0, 4) }));
  }
  function quitarTramo(dia: string, i: number) {
    tocado.current = true;
    setHours((h) => {
      const lista = (h[dia] ?? []).filter((_, j) => j !== i);
      const next = { ...h };
      if (lista.length) next[dia] = lista;
      else delete next[dia];
      return next;
    });
  }
  function cambiarTramo(dia: string, i: number, campo: "from" | "to", valor: string) {
    tocado.current = true;
    setHours((h) => ({ ...h, [dia]: (h[dia] ?? []).map((t, j) => (j === i ? { ...t, [campo]: valor } : t)) }));
  }
  /** Copia el horario del lunes al resto de los días laborales (el caso más común). */
  function aplicarALaborales() {
    tocado.current = true;
    const base = hours.mon;
    if (!base?.length) return;
    setHours((h) => {
      const next = { ...h };
      for (const d of LABORALES) next[d] = base.map((t) => ({ ...t }));
      return next;
    });
  }

  /** Un tramo es válido si abre antes de cerrar: guardar al revés deja el día sin horas. */
  const tramosInvalidos = Object.entries(hours).flatMap(([dia, lista]) =>
    lista.filter((t) => t.from >= t.to).map(() => DIAS.find((d) => d.key === dia)?.label ?? dia),
  );
  const algunDiaAbierto = Object.values(hours).some((l) => l.length > 0);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setError(null);
    if (tramosInvalidos.length) {
      setError(`Revisa el horario de ${[...new Set(tramosInvalidos)].join(", ")}: la hora de cierre tiene que ser posterior a la de apertura.`);
      return;
    }
    setBusy(true);
    try {
      await api("/settings/business", {
        method: "PUT",
        body: JSON.stringify({
          nombre: nombre.trim() || undefined,
          rubro: rubro || undefined,
          direccion: direccion.trim() || undefined,
          descripcion: descripcion.trim() || undefined,
        }),
      });
      // El horario va aparte porque vive en otra clave de configuración; si falla, el aviso
      // lo dice y los datos del negocio ya quedaron guardados (no se pierde el trabajo).
      await api("/settings/hours", { method: "PUT", body: JSON.stringify({ hours }) });
      setMsg("Listo: tu asistente ya responde con estos datos.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const faltan = [!nombre.trim() && "el nombre", !rubro && "el rubro", !direccion.trim() && "la dirección", !algunDiaAbierto && "el horario"].filter(Boolean) as string[];

  return (
    <form onSubmit={guardar} className="card" style={{ padding: 20, marginBottom: 16 }} data-copilot="negocio-datos">
      <h2 className="display" style={{ fontSize: 18, margin: "0 0 4px" }}>Tu negocio</h2>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>
        Con esto tu asistente responde bien desde el primer mensaje: sabe cómo se llama tu negocio, a qué se dedica, dónde está y cuándo atiende.
      </p>
      {faltan.length ? (
        <p style={{ fontSize: 13, color: "var(--warn, var(--ink-dim))", margin: "0 0 12px" }}>Falta {faltan.join(", ")}.</p>
      ) : null}
      {msg ? <p style={{ color: "var(--ok)", fontSize: 13, margin: "0 0 10px" }}>{msg}</p> : null}
      {error ? <p style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 10px" }}>{error}</p> : null}

      <label style={labelStyle}>
        Nombre del negocio
        <input value={nombre} onChange={(e) => { tocado.current = true; setNombre(e.target.value); }} placeholder="Barbería Central" style={inputStyle} />
      </label>

      <label style={{ ...labelStyle, marginTop: 12 }}>
        Rubro
        <select value={rubro} onChange={(e) => { tocado.current = true; setRubro(e.target.value); }} style={inputStyle}>
          <option value="">Elige tu rubro…</option>
          {(negocio?.rubros ?? []).map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </select>
      </label>

      <label style={{ ...labelStyle, marginTop: 12 }}>
        Dirección
        <input value={direccion} onChange={(e) => { tocado.current = true; setDireccion(e.target.value); }} placeholder="Av. Siempre Viva 742, Providencia" style={inputStyle} />
      </label>

      <label style={{ ...labelStyle, marginTop: 12 }}>
        ¿Qué hace tu negocio? (opcional)
        <textarea value={descripcion} onChange={(e) => { tocado.current = true; setDescripcion(e.target.value); }} rows={2} placeholder="Cortes de pelo y barba, atención sin reserva previa." style={{ ...inputStyle, resize: "vertical" }} />
      </label>

      <div style={{ marginTop: 20 }} data-copilot="negocio-horario">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>Horario de atención</h3>
          {hours.mon?.length ? (
            <button type="button" onClick={aplicarALaborales} className="text-accent" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: 0 }}>
              Aplicar el lunes a toda la semana laboral
            </button>
          ) : null}
        </div>
        <p className="text-dim" style={{ fontSize: 12, margin: "4px 0 10px" }}>
          Si cierras a mediodía, agrega dos tramos en ese día.
        </p>
        {DIAS.map((d) => {
          const lista = hours[d.key] ?? [];
          const abierto = lista.length > 0;
          return (
            <div key={d.key} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 0", borderTop: "1px solid var(--hairline)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, width: 118, flexShrink: 0, fontSize: 13, paddingTop: 7, cursor: "pointer" }}>
                <input type="checkbox" checked={abierto} onChange={(e) => (e.target.checked ? abrir(d.key) : cerrar(d.key))} aria-label={`${d.label}: abre`} />
                {d.label}
              </label>
              {abierto ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  {lista.map((t, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <input type="time" value={t.from} onChange={(e) => cambiarTramo(d.key, i, "from", e.target.value)} aria-label={`${d.label}: abre a las`} style={{ ...inputStyle, marginTop: 0, width: 116, padding: "7px 9px" }} />
                      <span className="text-dim" style={{ fontSize: 13 }}>a</span>
                      <input type="time" value={t.to} onChange={(e) => cambiarTramo(d.key, i, "to", e.target.value)} aria-label={`${d.label}: cierra a las`} style={{ ...inputStyle, marginTop: 0, width: 116, padding: "7px 9px" }} />
                      <button type="button" onClick={() => quitarTramo(d.key, i)} aria-label={`Quitar tramo de ${d.label}`} className="card" style={{ cursor: "pointer", padding: 5, lineHeight: 0 }}><X size={13} /></button>
                      {i === lista.length - 1 && lista.length < 4 ? (
                        <button type="button" onClick={() => agregarTramo(d.key)} aria-label={`Agregar tramo a ${d.label}`} className="card" style={{ cursor: "pointer", padding: 5, lineHeight: 0 }}><Plus size={13} /></button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-dim" style={{ fontSize: 13, paddingTop: 7 }}>Cerrado</span>
              )}
            </div>
          );
        })}
      </div>

      <button className="btn-accent" type="submit" disabled={busy} style={{ marginTop: 18, opacity: busy ? 0.6 : 1 }}>
        {busy ? "Guardando…" : "Guardar datos del negocio"}
      </button>
    </form>
  );
}
