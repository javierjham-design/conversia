"use client";

import { FlowChargingConfig } from "@/components/flow-charging-config";

export default function CobrosPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Cobros con Flow</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Conecta tu cuenta de <b>Flow</b> para que tus agentes de IA envíen links de pago con el monto exacto del pedido.
          Los pagos recibidos quedan registrados en <b>Reportes</b>. Esta configuración aplica a toda tu cuenta; el interruptor
          por agente (“Cobrar con link de pago”) está en la configuración de cada agente.
        </p>
      </div>
      <FlowChargingConfig />
    </div>
  );
}
