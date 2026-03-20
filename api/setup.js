/**
 * setup.js
 * Endpoint para registrar una clínica en el sistema.
 * Usar el martes al conectar GHL.
 *
 * POST /api/setup
 * Body: { secret, name, ghl_location_id, ghl_api_key, ghl_calendar_id, ...resto }
 * Returns: { clinic_id, webhook_url, dashboard_url }
 */

const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Protección básica con secret
  const { secret, ...clinicData } = req.body;
  if (secret !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const required = ["name", "ghl_location_id", "ghl_api_key", "ghl_calendar_id"];
  for (const field of required) {
    if (!clinicData[field]) return res.status(400).json({ error: `${field} is required` });
  }

  const supabase = getSupabase();

  console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
  console.log("KEY_START:", process.env.SUPABASE_SERVICE_KEY?.slice(0, 20));

  let clinic, error;
  try {
    ({ data: clinic, error } = await supabase
      .from("clinics")
      .upsert(clinicData, { onConflict: "ghl_location_id" })
      .select()
      .single());
  } catch (e) {
    console.error("SUPABASE_CATCH:", e.message, e.cause?.message);
    return res.status(500).json({ error: e.message, cause: e.cause?.message });
  }

  if (error) return res.status(500).json({ error: error.message });

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://backend-tau-mauve-boqpjn66jt.vercel.app";

  res.status(200).json({
    ok: true,
    clinic_id: clinic.id,
    clinic_name: clinic.name,
    webhook_url: `${baseUrl}/api/webhook`,
    dashboard_url: `https://dashboard-ten-peach-55.vercel.app?clinic=${clinic.id}`,
  });
};
