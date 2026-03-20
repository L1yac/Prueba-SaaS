const { getSupabase } = require("../lib/supabase");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const supabase = getSupabase();
  const { clinic_id, lead_id } = req.query;

  if (!clinic_id) return res.status(400).json({ error: "clinic_id required" });

  if (lead_id) {
    // Single lead with full conversation
    const [{ data: lead }, { data: conversations }, { data: appointments }] = await Promise.all([
      supabase.from("leads").select("*, lead_qualification(*)").eq("id", lead_id).single(),
      supabase.from("conversations").select("*").eq("lead_id", lead_id).order("created_at", { ascending: true }),
      supabase.from("appointments").select("*").eq("lead_id", lead_id).order("start_time", { ascending: false }),
    ]);
    return res.status(200).json({ lead, conversations, appointments });
  }

  // Lead list
  const { data: leads, error } = await supabase
    .from("leads")
    .select("*, lead_qualification(*), appointments(id, start_time, status)")
    .eq("clinic_id", clinic_id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ leads });
};
