const ghl = require("../lib/ghl");

module.exports = async function handler(req, res) {
  // Use known values directly from Supabase screenshot
  const apiKey = process.env.GHL_API_KEY_DEBUG || req.query.apikey;
  const calendarId = "QZGHjDImBS9mwcAWctO5";
  const tz = "Europe/Madrid";

  if (!apiKey) {
    return res.status(400).json({ error: "Pass ?apikey=YOUR_GHL_API_KEY in the URL" });
  }

  const slotsResult = await ghl.getFreeSlots(apiKey, calendarId, tz);

  res.status(200).json({
    calendar_id: calendarId,
    api_status: slotsResult.status,
    raw_response: slotsResult.data,
    extracted_slots: ghl.extractSlots(slotsResult.data),
  });
};
