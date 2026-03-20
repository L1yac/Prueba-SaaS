/**
 * cron/reminders.js
 * Vercel cron — se ejecuta cada hora.
 * Envía recordatorios 24h y 2h antes de cada cita.
 */

const { getSupabase } = require("../../lib/supabase");
const { sendMessage } = require("../../lib/ghl");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const supabase = getSupabase();
  const now = new Date();
  let sent = 0;

  // ── Recordatorio 24h ─────────────────────────────────────────
  const in24h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const in26h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  const { data: appts24 } = await supabase
    .from("appointments")
    .select("*, leads(name, phone, ghl_contact_id, do_not_contact), clinics(name, clinic_address, ghl_api_key, ghl_location_id)")
    .eq("reminder_24h_sent", false)
    .eq("status", "scheduled")
    .gte("start_time", in24h.toISOString())
    .lte("start_time", in26h.toISOString());

  for (const appt of appts24 || []) {
    const lead = appt.leads;
    const clinic = appt.clinics;
    if (!lead || lead.do_not_contact || !lead.ghl_contact_id) continue;

    const hora = new Date(appt.start_time).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    const msg = `Hola${lead.name ? " " + lead.name.split(" ")[0] : ""}! 👋 Te recuerdo que mañana tienes cita a las ${hora} en ${clinic.name}. ¿Confirmas que podrás venir? Responde SÍ o NO.`;

    await sendMessage(clinic.ghl_api_key, lead.ghl_contact_id, clinic.ghl_location_id, msg);
    await supabase.from("appointments").update({ reminder_24h_sent: true }).eq("id", appt.id);
    await supabase.from("conversations").insert({
      lead_id: appt.lead_id,
      direction: "outbound",
      message: msg,
      canal: "whatsapp",
    });
    sent++;
  }

  // ── Recordatorio 2h ──────────────────────────────────────────
  const in1h = new Date(now.getTime() + 60 * 60 * 1000);
  const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const { data: appts2h } = await supabase
    .from("appointments")
    .select("*, leads(name, phone, ghl_contact_id, do_not_contact), clinics(name, clinic_address, ghl_api_key, ghl_location_id)")
    .eq("reminder_2h_sent", false)
    .eq("status", "scheduled")
    .gte("start_time", in1h.toISOString())
    .lte("start_time", in3h.toISOString());

  for (const appt of appts2h || []) {
    const lead = appt.leads;
    const clinic = appt.clinics;
    if (!lead || lead.do_not_contact || !lead.ghl_contact_id) continue;

    const hora = new Date(appt.start_time).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    const msg = `¡Hola! En 2 horas tienes tu cita a las ${hora} en ${clinic.name}. Te esperamos en ${clinic.clinic_address || "nuestra clínica"}. ¡Hasta pronto! 😊`;

    await sendMessage(clinic.ghl_api_key, lead.ghl_contact_id, clinic.ghl_location_id, msg);
    await supabase.from("appointments").update({ reminder_2h_sent: true }).eq("id", appt.id);
    await supabase.from("conversations").insert({
      lead_id: appt.lead_id,
      direction: "outbound",
      message: msg,
      canal: "whatsapp",
    });
    sent++;
  }

  console.log(`Reminders cron: ${sent} enviados`);
  res.status(200).json({ ok: true, sent });
};
