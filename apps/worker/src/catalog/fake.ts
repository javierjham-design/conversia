/** Adaptador FALSO para probar el motor de sync sin pegarle a ninguna API real. */
import type { CatalogAdapter, NormalizedItem, OnPage } from "./types";

export class FakeCatalogAdapter implements CatalogAdapter {
  readonly source = "fake";
  constructor(
    private items: NormalizedItem[],
    private pageSize = 2,
  ) {}
  async testConnection() {
    return { ok: true, count: this.items.length, error: null };
  }
  async fetchAll(onPage: OnPage) {
    for (let i = 0; i < this.items.length; i += this.pageSize) {
      await onPage(this.items.slice(i, i + this.pageSize));
    }
  }
  async fetchSince(_since: Date, onPage: OnPage) {
    await onPage(this.items);
  }
  normalize(raw: unknown) {
    return raw as NormalizedItem;
  }
}
