import { AppShell } from "@/components/AppShell";

/** Placeholder de sección con el shell de navegación (F3 Tramo 2). Las pantallas
 *  completas llegan en los tramos siguientes. */
export function SectionStub({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <AppShell>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 6px" }}>{title}</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>{subtitle}</p>
        <div className="card" style={{ padding: 28, textAlign: "center" }}>
          <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Esta sección llega en el próximo tramo. La navegación ya es la definitiva.</p>
        </div>
      </main>
    </AppShell>
  );
}
