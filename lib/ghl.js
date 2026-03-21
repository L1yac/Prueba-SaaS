const https = require("https");

function makeRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendMessage(apiKey, contactId, locationId, message) {
  const payload = JSON.stringify({ type: "WhatsApp", contactId, locationId, message });
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: "/conversations/messages",
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, payload);
}

async function getContact(apiKey, contactId) {
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: "/contacts/" + contactId,
    method: "GET",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
    },
  });
}

async function getFreeSlots(apiKey, calendarId, timezone = "Europe/Madrid") {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const qs = `startDate=${start.getTime()}&endDate=${end.getTime()}&timezone=${encodeURIComponent(timezone)}`;
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: `/calendars/${calendarId}/free-slots?${qs}`,
    method: "GET",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
    },
  });
}

async function bookAppointment(apiKey, { calendarId, locationId, contactId, startTime, name }) {
  const start = new Date(startTime);
  const endTime = new Date(start.getTime() + 30 * 60 * 1000).toISOString();
  const payload = JSON.stringify({
    calendarId, locationId, contactId, startTime, endTime,
    appointmentStatus: "confirmed",
    selectedTimezone: "Europe/Madrid",
    title: `Cita - ${name}`,
  });
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: "/calendars/events/appointments",
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, payload);
}

function extractSlots(data, limit = 2) {
  const slots = [];
  const dates = data._dates_ || data;
  if (typeof dates !== "object") return slots;
  for (const date of Object.keys(dates).sort()) {
    const dayData = dates[date];
    const daySlots = Array.isArray(dayData) ? dayData : (dayData?.slots || []);
    for (const slot of daySlots) {
      if (slots.length < limit) slots.push(slot);
    }
    if (slots.length >= limit) break;
  }
  return slots;
}

function formatSlotsMessage(slots) {
  const formatted = slots.map((slot, i) => {
    const d = new Date(slot);
    const date = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    const time = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    return `${i + 1}️⃣ ${date} – ${time} [${slot}]`;
  });
  return `Tengo estos huecos disponibles:\n\n${formatted.join("\n")}\n\n¿Con cuál te quedas? Responde 1 o 2.`;
}

async function updateContact(apiKey, contactId, fields) {
  const payload = JSON.stringify(fields);
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: "/contacts/" + contactId,
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, payload);
}

async function getFreeSlotsByDate(apiKey, calendarId, dateStr, timezone = "Europe/Madrid") {
  // dateStr: "YYYY-MM-DD"
  const start = new Date(dateStr + "T00:00:00");
  const end = new Date(dateStr + "T23:59:59");
  const qs = `startDate=${start.getTime()}&endDate=${end.getTime()}&timezone=${encodeURIComponent(timezone)}`;
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: `/calendars/${calendarId}/free-slots?${qs}`,
    method: "GET",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
    },
  });
}

async function cancelAppointment(apiKey, appointmentId) {
  return makeRequest({
    hostname: "services.leadconnectorhq.com",
    path: `/calendars/events/appointments/${appointmentId}`,
    method: "DELETE",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Version": "2021-04-15",
    },
  });
}

module.exports = { sendMessage, getContact, getFreeSlots, getFreeSlotsByDate, bookAppointment, cancelAppointment, updateContact, extractSlots, formatSlotsMessage };
