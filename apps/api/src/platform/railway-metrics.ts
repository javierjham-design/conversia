/**
 * Cliente de la API GraphQL de Railway para el monitor de infraestructura del
 * Super Admin. Lee la topología (proyectos → servicios), las métricas actuales por
 * servicio (CPU vCPU, RAM GB) y el uso mensual estimado por proyecto. El token es de
 * WORKSPACE (RAILWAY_API_TOKEN) — ve TODOS los proyectos de la cuenta (Conversia y
 * Cláriva conviven ahí). Solo lecturas.
 */
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

async function railwayGraphQL<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("Respuesta vacía de Railway");
  return json.data;
}

export interface RailwayService {
  id: string;
  name: string;
  cpu: number | null; // vCPU actuales
  cpuLimit: number | null; // vCPU asignados
  memoryGb: number | null; // RAM GB actuales
  memoryLimitGb: number | null; // RAM GB asignados
}
export interface RailwayProject {
  id: string;
  name: string;
  services: RailwayService[];
  usage: Record<string, number>; // uso mensual estimado por medición
}

const PROJECTS_Q = `query{ projects{ edges{ node{ id name services{ edges{ node{ id name } } } } } } }`;
const METRICS_Q = `query($s:String!,$a:DateTime!,$b:DateTime!){ metrics(serviceId:$s, measurements:[CPU_USAGE,CPU_LIMIT,MEMORY_USAGE_GB,MEMORY_LIMIT_GB], startDate:$a, endDate:$b, sampleRateSeconds:300){ measurement values{ ts value } } }`;
const USAGE_Q = `query($p:String!){ estimatedUsage(projectId:$p, measurements:[CPU_USAGE,MEMORY_USAGE_GB,DISK_USAGE_GB,NETWORK_TX_GB,BACKUP_USAGE_GB]){ measurement estimatedValue } }`;

type ProjectsResp = { projects: { edges: Array<{ node: { id: string; name: string; services: { edges: Array<{ node: { id: string; name: string } }> } } }> } };
type MetricsResp = { metrics: Array<{ measurement: string; values: Array<{ ts: number; value: number }> }> };
type UsageResp = { estimatedUsage: Array<{ measurement: string; estimatedValue: number }> };

/** Último valor de una serie (la muestra más reciente). */
function last(values: Array<{ ts: number; value: number }>): number | null {
  if (!values?.length) return null;
  return values[values.length - 1].value;
}

export async function getRailwayInfra(token: string): Promise<RailwayProject[]> {
  const { projects } = await railwayGraphQL<ProjectsResp>(token, PROJECTS_Q);
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const out: RailwayProject[] = [];
  for (const { node } of projects.edges) {
    const services = node.services.edges.map((e) => e.node);
    // Métricas actuales por servicio, en paralelo.
    const withMetrics = await Promise.all(
      services.map(async (svc): Promise<RailwayService> => {
        const pick = (metrics: MetricsResp["metrics"], name: string) => last(metrics.find((m) => m.measurement === name)?.values ?? []);
        try {
          const { metrics } = await railwayGraphQL<MetricsResp>(token, METRICS_Q, { s: svc.id, a: start, b: end });
          return {
            id: svc.id,
            name: svc.name,
            cpu: pick(metrics, "CPU_USAGE"),
            cpuLimit: pick(metrics, "CPU_LIMIT"),
            memoryGb: pick(metrics, "MEMORY_USAGE_GB"),
            memoryLimitGb: pick(metrics, "MEMORY_LIMIT_GB"),
          };
        } catch {
          return { id: svc.id, name: svc.name, cpu: null, cpuLimit: null, memoryGb: null, memoryLimitGb: null };
        }
      }),
    );
    // Uso mensual estimado del proyecto.
    let usage: Record<string, number> = {};
    try {
      const u = await railwayGraphQL<UsageResp>(token, USAGE_Q, { p: node.id });
      usage = Object.fromEntries(u.estimatedUsage.map((x) => [x.measurement, x.estimatedValue]));
    } catch {
      /* sin uso estimado */
    }
    out.push({ id: node.id, name: node.name, services: withMetrics, usage });
  }
  return out;
}
