const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const supabase = getSupabase();
  const { clinic_id } = req.query;
  if (!clinic_id) return res.status(400).json({ error: "clinic_id required" });

  const [
    { count: total },
    { count: booked },
    { count: escalated },
    { count: lost },
  ] = await Promise.all([
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("clinic_id", clinic_id),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("clinic_id", clinic_id).eq("status", "AGENDADO"),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("clinic_id", clinic_id).eq("status", "ESCALADO"),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("clinic_id", clinic_id).eq("status", "PERDIDO"),
  ]);

  const conversionRate = total > 0 ? Math.round((booked / total) * 100) : 0;

  res.status(200).json({
    total_leads: total,
    booked,
    escalated,
    lost,
    conversion_rate: conversionRate,
  });
};
