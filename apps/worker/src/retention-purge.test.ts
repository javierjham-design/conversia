import { describe, expect, it } from "vitest";
import { retentionCutoff } from "./retention-purge";

describe("retención — corte de fechas", () => {
  const now = new Date("2026-08-05T00:00:00Z");

  it("0 o negativo = indefinido (null, no purga)", () => {
    expect(retentionCutoff(0, now)).toBeNull();
    expect(retentionCutoff(-3, now)).toBeNull();
    expect(retentionCutoff(NaN, now)).toBeNull();
  });

  it("N meses → fecha de corte hacia atrás", () => {
    const c6 = retentionCutoff(6, now)!;
    expect(c6).toBeInstanceOf(Date);
    expect(c6.getTime()).toBeLessThan(now.getTime());
    // ~6 meses ≈ 182-183 días.
    const days = Math.round((now.getTime() - c6.getTime()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(180);
    expect(days).toBeLessThanOrEqual(184);
  });

  it("más meses → corte más antiguo", () => {
    expect(retentionCutoff(24, now)!.getTime()).toBeLessThan(retentionCutoff(12, now)!.getTime());
  });
});
