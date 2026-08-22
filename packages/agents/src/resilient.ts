import type { AIChatRequest, AIChatResponse, AIProvider, AIUsage } from "@conversia/types";

/**
 * Envuelve un AIProvider con RESILIENCIA para que un fallo transitorio del
 * proveedor (429/503/timeout de red) nunca deje al cliente en silencio:
 *   1. Timeout por llamada (evita colgarse esperando al proveedor).
 *   2. Reintentos con backoff exponencial + jitter.
 *   3. Fallback a un modelo alternativo si el principal agota sus intentos.
 * Si TODO falla, lanza el último error — el llamador (agent-turn) aplica el
 * "modo degradado" (mensaje humano honesto + escalamiento), nunca silencio.
 */
export interface ResilienceOptions {
  maxAttempts: number; // intentos por modelo
  timeoutMs: number; // timeout por llamada
  fallbackModel?: string; // modelo alternativo si el principal falla del todo
  baseDelayMs?: number; // backoff base (default 500ms)
  onRetry?: (info: { model: string; attempt: number; error: string }) => void;
  sleep?: (ms: number) => Promise<void>; // inyectable para tests
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`AI call timeout tras ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class ResilientAIProvider implements AIProvider {
  readonly kind: string;
  constructor(
    private inner: AIProvider,
    private opts: ResilienceOptions,
  ) {
    this.kind = inner.kind;
  }

  async chat(req: AIChatRequest): Promise<AIChatResponse> {
    const sleep = this.opts.sleep ?? defaultSleep;
    const base = this.opts.baseDelayMs ?? 500;
    const models = [req.model];
    if (this.opts.fallbackModel && this.opts.fallbackModel !== req.model) models.push(this.opts.fallbackModel);

    let lastErr: unknown;
    for (const model of models) {
      for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
        try {
          const r = await withTimeout(
            this.inner.chat(model === req.model ? req : { ...req, model }),
            this.opts.timeoutMs,
          );
          return r;
        } catch (err) {
          lastErr = err;
          this.opts.onRetry?.({ model, attempt, error: (err as Error)?.message ?? String(err) });
          const isLastAttemptOfModel = attempt >= this.opts.maxAttempts;
          const isLastModel = model === models[models.length - 1];
          if (isLastAttemptOfModel && isLastModel) break;
          if (isLastAttemptOfModel) break; // pasa al siguiente modelo sin dormir de más
          // backoff exponencial con jitter (sin Math.random para no romper resúmenes: jitter por intento)
          const delay = base * 2 ** (attempt - 1) + attempt * 37;
          await sleep(delay);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  embed(texts: string[], model?: string): Promise<{ vectors: number[][]; usage: AIUsage }> {
    return this.inner.embed(texts, model);
  }
}
