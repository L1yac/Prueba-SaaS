const { getSupabase } = require("../lib/supabase");
const ghl = require("../lib/ghl");
const { getSaraDecision } = require("../lib/sara");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body;
  const supabase = getSupabase();

  try {
    const { type, locationId } = event;

    const { data: clinic } = await supabase
      .from("clinics")
      .select("*")
      .eq("ghl_location_id", locationId)
      .single();

    if (!clinic) {
      console.error("Clinic not found for locationId:", locationId);
      return res.status(200).end();
    }

    if (type === "ContactCreate") {
      await handleNewContact(supabase, clinic, event);
    } else if (type === "InboundMessage") {
      await handleInboundMessage(supabase, clinic, event);
    } else {
      console.log("Unhandled event type:", type);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end(); // Always 200 to GHL to avoid retries
  }
};

async function handleNewContact(supabase, clinic, event) {
  const { contactId, phone, firstName, lastName, email, source } = event;
  const name = [firstName, lastName].filter(Boolean).join(" ");

  const { data: lead } = await supabase
    .from("leads")
    .upsert({
      clinic_id: clinic.id,
      ghl_contact_id: contactId,
      name,
      phone: phone || "",
      email: email || "",
      source: source || "",
      status: "CONTACTADO",
    }, { onConflict: "ghl_contact_id" })
    .select()
    .single();

  const greeting = firstName ? ` ${firstName}` : "";
  const msg = `¡Hola${greeting}! 👋 Soy Sara, la asistente de ${clinic.name}. Vi que te interesaste en nuestros servicios dentales. ¿Qué tratamiento estás buscando?`;

  await ghl.sendMessage(clinic.ghl_api_key, contactId, clinic.ghl_location_id, msg);

  await supabase.from("conversations").insert({
    lead_id: lead.id,
    direction: "outbound",
    message: msg,
    canal: "whatsapp",
  });
}

async function handleInboundMessage(supabase, clinic, event) {
  const { contactId, phone, message: inboundMsg, firstName, lastName } = event;

  // Find or create lead
  let { data: lead } = await supabase
    .from("leads")
    .select("*")
    .eq("ghl_contact_id", contactId)
    .single();

  if (!lead) {
    const name = [firstName, lastName].filter(Boolean).join(" ");
    const { data: newLead } = await supabase
      .from("leads")
      .insert({
        clinic_id: clinic.id,
        ghl_contact_id: contactId,
        name,
        phone: phone || "",
        status: "CONTACTADO",
      })
      .select()
      .single();
    lead = newLead;
  }

  if (lead.do_not_contact) return;

  // Handle STOP
  if (inboundMsg?.trim().toUpperCase() === "STOP") {
    await supabase.from("leads").update({ do_not_contact: true }).eq("id", lead.id);
    return;
  }

  // Log inbound
  await supabase.from("conversations").insert({
    lead_id: lead.id,
    direction: "inbound",
    message: inboundMsg,
    canal: "whatsapp",
  });

  // Get conversation history (last 20)
  const { data: history } = await supabase
    .from("conversations")
    .select("direction, message")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: true })
    .limit(20);

  const conversationHistory = history.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.message,
  }));

  // Get qualification
  const { data: qualification } = await supabase
    .from("lead_qualification")
    .select("*")
    .eq("lead_id", lead.id)
    .single();

  // Ask Sara
  const decision = await getSaraDecision(clinic, lead, qualification, conversationHistory);
  console.log("Sara decision:", decision.action, "|", decision.reasoning);

  // Handle actions
  if (decision.action === "unsubscribe") {
    await supabase.from("leads").update({ do_not_contact: true }).eq("id", lead.id);
    return;
  }

  if (decision.action === "show_slots") {
    const slotsResult = await ghl.getFreeSlots(
      clinic.ghl_api_key,
      clinic.ghl_calendar_id,
      clinic.clinic_timezone || "Europe/Madrid"
    );
    const slots = ghl.extractSlots(slotsResult.data);
    if (slots.length > 0) {
      const slotsMsg = ghl.formatSlotsMessage(slots);
      decision.message = (decision.message ? decision.message + " ||| " : "") + slotsMsg;
    } else {
      decision.message = (decision.message ? decision.message + " ||| " : "") + "En este momento no veo huecos disponibles. ¿Te parece si te contacto en cuanto haya uno?";
    }
    decision.action = "send_message";
  }

  if (decision.action === "book_appointment" && decision.appointment_slot) {
    const apptResult = await ghl.bookAppointment(clinic.ghl_api_key, {
      calendarId: clinic.ghl_calendar_id,
      locationId: clinic.ghl_location_id,
      contactId,
      startTime: decision.appointment_slot,
      name: lead.name || "Lead",
    });

    if (apptResult.status === 200 || apptResult.status === 201) {
      await supabase.from("appointments").insert({
        lead_id: lead.id,
        clinic_id: clinic.id,
        ghl_appointment_id: apptResult.data?.id,
        start_time: decision.appointment_slot,
        end_time: new Date(new Date(decision.appointment_slot).getTime() + 30 * 60 * 1000).toISOString(),
        status: "scheduled",
      });
      decision.status_update = "AGENDADO";
    } else {
      console.error("Booking failed:", apptResult.data);
      // Si el slot ya no está disponible, mostrar nuevos horarios
      const slotsResult = await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, clinic.clinic_timezone || "Europe/Madrid");
      const slots = ghl.extractSlots(slotsResult.data);
      if (slots.length > 0) {
        decision.message = "Ese horario ya no está disponible. Estos son los próximos horarios libres:\n\n" + ghl.formatSlotsMessage(slots).replace("Estos son los próximos horarios disponibles:\n\n", "");
      } else {
        decision.message = "Ese horario ya no está disponible. ¿Te puedo contactar cuando haya un hueco libre?";
      }
    }
    decision.action = "send_message";
  }

  if (decision.action === "handoff") {
    if (clinic.staff_phone) {
      // Notify staff via GHL message (to staff contact or internal note)
      console.log("Handoff requested for lead:", lead.id);
    }
    decision.status_update = "ESCALADO";
    decision.action = "send_message";
  }

  // Send messages
  if (decision.message && decision.action !== "wait") {
    const parts = decision.message.split("|||").map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      await ghl.sendMessage(clinic.ghl_api_key, contactId, clinic.ghl_location_id, part);
      await supabase.from("conversations").insert({
        lead_id: lead.id,
        direction: "outbound",
        message: part,
        canal: "whatsapp",
      });
    }
  }

  // Update lead status
  if (decision.status_update && decision.status_update !== lead.status) {
    await supabase.from("leads").update({ status: decision.status_update }).eq("id", lead.id);
  }

  // Update qualification
  if (decision.qualification_updates) {
    const updates = Object.fromEntries(
      Object.entries(decision.qualification_updates).filter(([, v]) => v !== null && v !== undefined)
    );
    if (Object.keys(updates).length > 0) {
      await supabase.from("lead_qualification").upsert(
        { lead_id: lead.id, ...updates },
        { onConflict: "lead_id" }
      );
    }
  }
}
