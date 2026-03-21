const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");

module.exports = async function handler(req, res) {
  const supabase = getSupabase();
  const { data: clinics, error: clinicError } = await supabase
    .from("clinics")
    .select("*")
    .limit(1);

  if (clinicError) return res.status(500).json({ error: clinicError.message });
  const clinic = clinics?.[0];
  if (!clinic) return res.status(404).json({ error: "No clinic found" });

  const tz = clinic.clinic_timezone || "Europe/Madrid";
  const slotsResult = await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, tz);

  res.status(200).json({
    clinic_name: clinic.name,
    calendar_id: clinic.ghl_calendar_id,
    timezone: tz,
    api_status: slotsResult.status,
    raw_response: slotsResult.data,
    extracted_slots: ghl.extractSlots(slotsResult.data),
  });
};
