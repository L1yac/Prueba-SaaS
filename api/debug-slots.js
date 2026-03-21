const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");

const KNOWN_LOCATION_ID = "sozVKqY3uIUJCqIL6wBd";
const KNOWN_API_KEY = "pit-04405605-858e-443d-ac9c-70d0fc24bc93";
const KNOWN_CALENDAR_ID = "QZGHjDImBS9mwcAWctO5";

module.exports = async function handler(req, res) {
  const supabase = getSupabase();

  // Test 1: get ALL clinics to see what's in the table
  const { data: allClinics, error: allError } = await supabase.from("clinics").select("id, name, ghl_location_id");
  const clinic = allClinics?.find(c => c.ghl_location_id === KNOWN_LOCATION_ID) || allClinics?.[0];
  const clinicError = allError;

  // Test 2: slots with clinic data from Supabase (if found)
  let slotsFromSupabase = null;
  if (clinic) {
    const r = await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, clinic.clinic_timezone || "Europe/Madrid");
    slotsFromSupabase = {
      api_status: r.status,
      extracted: ghl.extractSlots(r.data),
      calendar_id_used: clinic.ghl_calendar_id,
      api_key_prefix: clinic.ghl_api_key?.slice(0, 15),
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
