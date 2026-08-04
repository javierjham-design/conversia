import type { SyncJob } from "@conversia/types";
import { sendGa4Event } from "./ga4";

/**
 * Despachador de la cola integration-sync: trabajos hacia integraciones
 * externas con reintentos/backoff. Un fallo aquí jamás toca el procesamiento
 * de mensajes (cola y worker separados).
 */
export async function processSyncJob(job: SyncJob): Promise<void> {
  switch (job.kind) {
    case "ga4_event":
      return sendGa4Event(job.organizationId, job.payload as { name: string; params?: Record<string, unknown>; clientId?: string });
    case "calendar_sync": {
      const { syncAppointmentToGoogle } = await import("./google-calendar.js");
      return syncAppointmentToGoogle(job.organizationId, job.payload as { appointmentId: string; action: "upsert" | "cancel" });
    }
    case "sheets_append": {
      const { appendSheetRow } = await import("./google-sheets.js");
      return appendSheetRow(job.organizationId, job.payload as { spreadsheetId: string; sheetName: string; values: string[] });
    }
    case "export_data": {
      const { processExport } = await import("./exports.js");
      return processExport(job.organizationId, job.payload as { exportId: string });
    }
    case "hubspot_contact": {
      const { syncContactToHubspot } = await import("./hubspot.js");
      return syncContactToHubspot(job.organizationId, job.payload as { contactId: string });
    }
    case "meta_ads_sync": {
      const { syncMetaAds, fanOutMetaAdsSync } = await import("./meta-ads-sync.js");
      // Job diario con {all:true} → abanica un sync por tenant conectado.
      if ((job.payload as { all?: boolean } | undefined)?.all) {
        await fanOutMetaAdsSync();
        return;
      }
      await syncMetaAds(job.organizationId);
      return;
    }
    default:
      console.warn(`⚠ SyncJob desconocido: ${(job as { kind?: string }).kind}`);
  }
}
