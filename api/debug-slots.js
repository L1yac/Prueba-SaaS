const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");

module.exports = async function handler(req, res) {
  if (req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getSupabase();
  const { data: clinic } = await supabase
    .from("clinics")
    .select("*")
    .single();

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
