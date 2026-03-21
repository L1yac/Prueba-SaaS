const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");

const KNOWN_LOCATION_ID = "sozVKqY3uIUJCqIL6wBd";
const KNOWN_API_KEY = "pit-04405605-858e-443d-ac9c-70d0fc24bc93";
const KNOWN_CALENDAR_ID = "QZGHjDImBS9mwcAWctO5";

module.exports = async function handler(req, res) {
  const supabase = getSupabase();

  // Register clinic if action=register
  if (req.query.action === "register") {
    const { data, error } = await supabase.from("clinics").upsert({
      name: "Clinica Prueba Dentraia",
      ghl_location_id: KNOWN_LOCATION_ID,
      ghl_api_key: KNOWN_API_KEY,
      ghl_calendar_id: KNOWN_CALENDAR_ID,
      clinic_timezone: "Europe/Madrid",
    }, { onConflict: "ghl_location_id" }).select().single();
    return res.status(200).json({ registered: !!data, error: error?.message, clinic: data });
  }

  // Test 1: get ALL clinics to see what's in the table
  const { data: allClinics, error: allError } = await supabase.from("clinics").select("id, name, ghl_location_id");
  const clinic = allClinics?.find(c => c.ghl_location_id === KNOWN_LOCATION_ID) || allClinics?.[0];
  const clinicError = allError;

  // Test 2: slots with clinic data from Supabase (if found)
  let slotsFromSupabase = null;
  if (clinic) {
    const fullClinic = await supabase.from("clinics").select("ghl_api_key, ghl_calendar_id, clinic_timezone").eq("id", clinic.id).single();
    const c = fullClinic.data;
    const r = await ghl.getFreeSlots(c.ghl_api_key, c.ghl_calendar_id, c.clinic_timezone || "Europe/Madrid");
    slotsFromSupabase = {
      api_status: r.status,
      api_error: r.data?.message || r.data,
      calendar_id_used: c.ghl_calendar_id,
      api_key_used: c.ghl_api_key,
      same_as_hardcoded_key: c.ghl_api_key === KNOWN_API_KEY,
      same_as_hardcoded_cal: c.ghl_calendar_id === KNOWN_CALENDAR_ID,
    };
  }

  // Test 3: slots with hardcoded known values
  const r2 = await ghl.getFreeSlots(KNOWN_API_KEY, KNOWN_CALENDAR_ID, "Europe/Madrid");
  const slotsFromHardcoded = {
    api_status: r2.status,
    extracted: ghl.extractSlots(r2.data),
  };

  res.status(200).json({
    all_clinics_in_table: allClinics,
    all_clinics_error: allError?.message,
    clinic_found: !!clinic,
    clinic_calendar_id: clinic?.ghl_calendar_id,
    slots_from_supabase_data: slotsFromSupabase,
    slots_from_hardcoded: slotsFromHardcoded,
  });
};
