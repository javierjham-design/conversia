/**
 * Mock de Cláriva — implementa el contrato preliminar docs/CLARIVA.md para
 * desarrollar la integración de agenda sin depender de la plataforma real.
 * Cláriva es un sistema EXTERNO: este mock reproduce solo su API pública.
 */
import express from "express";
import { z } from "zod";

const PORT = Number(process.env.MOCK_CLARIVA_PORT ?? 4010);
const API_KEY = process.env.CLARIVA_API_KEY ?? "dev-clariva-key";

const app = express();
app.use(express.json());

// Auth Bearer simple (el contrato real usará tokens por conexión/tenant)
app.use("/api", (req, res, next) => {
  const header = req.headers.authorization;
  if (header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ------------------------- datos en memoria -------------------------

const clinics = [
  { id: "cl-1", name: "Clínica Central (mock Cláriva)", address: "Av. Alemania 0555, Temuco", timezone: "America/Santiago" },
];
const professionals = [
  { id: "pr-1", name: "Dr. Mock Uno", specialty: "Odontología general", clinicIds: ["cl-1"] },
  { id: "pr-2", name: "Dra. Mock Dos", specialty: "Implantología", clinicIds: ["cl-1"] },
];
const services = [
  { id: "sv-1", name: "Evaluación", durationMin: 30, price: 15000, currency: "CLP" },
  { id: "sv-2", name: "Implante unitario", durationMin: 90, price: 950000, currency: "CLP" },
];

interface Appointment {
  id: string;
  clinicId: string;
  professionalId: string;
  serviceId?: string;
  patient: { firstName: string; lastName?: string; phone: string };
  start: string;
  end: string;
  status: "pending" | "confirmed" | "cancelled" | "rescheduled" | "completed" | "no_show";
  notes?: string;
}
const appointments = new Map<string, Appointment>();
let seq = 0;

// ----------------------------- endpoints -----------------------------

app.get("/api/v1/clinics", (_req, res) => res.json(clinics));
app.get("/api/v1/professionals", (_req, res) => res.json(professionals));
app.get("/api/v1/services", (_req, res) => res.json(services));
app.get("/api/v1/professionals/:id/services", (_req, res) => res.json(services));

app.get("/api/v1/availability", (req, res) => {
  const from = String(req.query.from ?? new Date().toISOString().slice(0, 10));
  const to = String(req.query.to ?? from);
  const professionalId = req.query.professionalId ? String(req.query.professionalId) : undefined;
  const slots: Array<{ start: string; end: string; professionalId: string; clinicId: string }> = [];
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(fromDate); d <= toDate && slots.length < 100; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) continue;
    const date = d.toISOString().slice(0, 10);
    for (const pr of professionals.filter((p) => !professionalId || p.id === professionalId)) {
      for (const time of ["10:00", "11:30", "15:00", "16:30"]) {
        const start = `${date}T${time}:00-04:00`;
        const taken = [...appointments.values()].some(
          (a) => a.professionalId === pr.id && a.status !== "cancelled" && a.start === start,
        );
        if (!taken && new Date(start).getTime() > Date.now()) {
          const end = new Date(new Date(start).getTime() + 30 * 60000).toISOString();
          slots.push({ start, end, professionalId: pr.id, clinicId: "cl-1" });
        }
      }
    }
  }
  res.json(slots);
});

const createApptSchema = z.object({
  clinicId: z.string(),
  professionalId: z.string(),
  serviceId: z.string().optional(),
  patient: z.object({
    firstName: z.string(),
    lastName: z.string().optional(),
    phone: z.string(),
    email: z.string().optional(),
  }),
  start: z.string(),
  end: z.string(),
  notes: z.string().optional(),
});

app.post("/api/v1/appointments", (req, res) => {
  const parsed = createApptSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const conflict = [...appointments.values()].some(
    (a) => a.professionalId === parsed.data.professionalId && a.status !== "cancelled" && a.start === parsed.data.start,
  );
  if (conflict) return res.status(409).json({ error: "slot_taken" });
  const appt: Appointment = { id: `clv-${++seq}`, status: "pending", ...parsed.data };
  appointments.set(appt.id, appt);
  console.log(`📅 [mock-clariva] cita creada ${appt.id}: ${appt.start} ${appt.patient.firstName} (${appt.patient.phone})`);
  res.status(201).json(appt);
});

app.get("/api/v1/appointments/:id", (req, res) => {
  const appt = appointments.get(req.params.id);
  if (!appt) return res.status(404).json({ error: "not_found" });
  res.json(appt);
});

app.patch("/api/v1/appointments/:id", (req, res) => {
  const appt = appointments.get(req.params.id);
  if (!appt) return res.status(404).json({ error: "not_found" });
  Object.assign(appt, req.body, { status: req.body.start ? "rescheduled" : appt.status });
  res.json(appt);
});

app.post("/api/v1/appointments/:id/cancel", (req, res) => {
  const appt = appointments.get(req.params.id);
  if (!appt) return res.status(404).json({ error: "not_found" });
  appt.status = "cancelled";
  res.json(appt);
});

app.post("/api/v1/appointments/:id/confirm", (req, res) => {
  const appt = appointments.get(req.params.id);
  if (!appt) return res.status(404).json({ error: "not_found" });
  appt.status = "confirmed";
  res.json(appt);
});

app.post("/api/v1/appointments/:id/attendance", (req, res) => {
  const appt = appointments.get(req.params.id);
  if (!appt) return res.status(404).json({ error: "not_found" });
  appt.status = req.body?.attended === false ? "no_show" : "completed";
  res.json(appt);
});

app.get("/api/v1/patients/:phone/appointments", (req, res) => {
  res.json([...appointments.values()].filter((a) => a.patient.phone === req.params.phone));
});

app.put("/api/v1/patients", (req, res) => res.json(req.body));

app.get("/health", (_req, res) => res.json({ ok: true, service: "mock-clariva" }));

app.listen(PORT, () => console.log(`✔ Mock Cláriva en http://localhost:${PORT} (API key: ${API_KEY})`));
