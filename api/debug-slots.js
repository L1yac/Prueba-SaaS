const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");

module.exports = async function handler(req, res) {
  const supabase = getSupabase();
  const { data: clinics, error: clinicError } = await supabase
    .from("clinics")
    .select("*");

  if (clinicError) return res.status(500).json({ error: clinicError.message, supabase_url: process.env.SUPABASE_URL?.slice(0, 30) });
  if (!clinics || clinics.length === 0) return res.status(404).json({
    error: "No clinic found",
    supabase_url: process.env.SUPABASE_URL?.slice(0, 30),
    key_prefix: process.env.SUPABASE_SERVICE_KEY?.slice(0, 10),
    rows_returned: clinics?.length,
  });
  const clinic = clinics[0];

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
