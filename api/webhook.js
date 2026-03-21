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

    const { data: clinics } = await supabase
      .from("clinics")
      .select("*")
      .eq("ghl_location_id", locationId)
      .limit(1);
    const clinic = clinics?.[0];

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

  // No proactive greeting here — Sara greets naturally on first InboundMessage
  // This avoids double greeting from the ContactCreate + InboundMessage race condition
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

  // Keyword override for cancel/reschedule when lead has appointment
  const msgNorm = inboundMsg?.trim().toLowerCase() || "";
  const cancelKeywords = ["cancelar", "cancel", "anular", "no voy a ir", "no puedo ir", "no voy"];
  const rescheduleKeywords = ["cambiar", "cambio", "reprogramar", "otra fecha", "otro día", "otro horario", "mover la cita"];
  let saraHint = null;
  if (lead.status === "AGENDADO") {
    if (cancelKeywords.some((k) => msgNorm.includes(k))) {
      saraHint = "cancel_appointment";
    } else if (rescheduleKeywords.some((k) => msgNorm.includes(k))) {
      saraHint = "reschedule_appointment";
    }
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

  // Auto-book if user responds "1" or "2" to slot options
  if (lead.status === "CALIFICADO" && !saraHint) {
    const userReply = inboundMsg?.trim();
    const recentSlotMsg = history?.slice().reverse().find(m =>
      m.direction === "outbound" && /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.test(m.message)
    );
    if (recentSlotMsg) {
      const isoMatches = [...recentSlotMsg.message.matchAll(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/g)];
      let chosenSlot = null;
      if (userReply === "1" && isoMatches[0]) chosenSlot = isoMatches[0][1];
      if (userReply === "2" && isoMatches[1]) chosenSlot = isoMatches[1][1];
      if (chosenSlot) saraHint = { type: "book_appointment", slot: chosenSlot };
    }
  }

  // Get qualification
  const { data: qualification } = await supabase
    .from("lead_qualification")
    .select("*")
    .eq("lead_id", lead.id)
    .single();

  // Direct book if user picked slot 1 or 2
  if (saraHint?.type === "book_appointment") {
    const apptResult = await ghl.bookAppointment(clinic.ghl_api_key, {
      calendarId: clinic.ghl_calendar_id,
      locationId: clinic.ghl_location_id,
      contactId,
      startTime: saraHint.slot,
      name: lead.name || "Lead",
    });
    let replyMsg;
    if (apptResult.status === 200 || apptResult.status === 201) {
      const d = new Date(saraHint.slot);
      const dateStr = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Madrid" });
      const timeStr = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
      replyMsg = `Perfecto, cita confirmada el ${dateStr} a las ${timeStr}. ¡Te esperamos!`;
      await supabase.from("appointments").insert({
        lead_id: lead.id, clinic_id: clinic.id,
        ghl_appointment_id: apptResult.data?.id,
        start_time: saraHint.slot,
        end_time: new Date(new Date(saraHint.slot).getTime() + 30 * 60 * 1000).toISOString(),
        status: "scheduled",
      });
      await supabase.from("leads").update({ status: "AGENDADO" }).eq("id", lead.id);
    } else {
      const slotsResult = await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, clinic.clinic_timezone || "Europe/Madrid");
      const slots = ghl.extractSlots(slotsResult.data);
      replyMsg = slots.length > 0 ? "Ese horario ya no está libre. " + ghl.formatSlotsMessage(slots) : "Ese horario ya no está libre. ¿Te contacto cuando haya uno?";
    }
    await ghl.sendMessage(clinic.ghl_api_key, contactId, clinic.ghl_location_id, replyMsg);
    await supabase.from("conversations").insert({ lead_id: lead.id, direction: "outbound", message: replyMsg, canal: "whatsapp" });
    return;
  }

  // Ask Sara
  const decision = await getSaraDecision(clinic, lead, qualification, conversationHistory, typeof saraHint === "string" ? saraHint : null);
  console.log("Sara decision:", decision.action, "|", decision.reasoning);

  // Handle actions
  if (decision.action === "unsubscribe") {
    await supabase.from("leads").update({ do_not_contact: true }).eq("id", lead.id);
    return;
  }

  // Force show_slots if Sara is in CALIFICADO and invents specific times
  if (lead.status === "CALIFICADO" && decision.action === "send_message") {
    const inventedTime = /\b\d{1,2}:\d{2}\b/.test(decision.message || "");
    const confirmingAppt = /(reservo|agend[oó]|cita.*confirm|confirm.*cita)/i.test(decision.message || "");
    if (inventedTime || confirmingAppt) {
      console.log("Sara invented a time in CALIFICADO — forcing show_slots");
      decision.action = "show_slots";
      decision.message = null;
    }
  }

  if (decision.action === "show_slots") {
    const tz = clinic.clinic_timezone || "Europe/Madrid";
    const slotsResult = decision.preferred_date
      ? await ghl.getFreeSlotsByDate(clinic.ghl_api_key, clinic.ghl_calendar_id, decision.preferred_date, tz)
      : await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, tz);
    console.log("FREE SLOTS RAW:", JSON.stringify(slotsResult).slice(0, 500));
    const slots = ghl.extractSlots(slotsResult.data);
    if (slots.length > 0) {
      const btnResult = await ghl.sendSlotsAsButtons(clinic.ghl_api_key, contactId, clinic.ghl_location_id, slots);
      if (btnResult.status === 200 || btnResult.status === 201) {
        // Buttons sent — store text version with ISOs in conversations for later booking lookup
        const slotText = ghl.formatSlotsMessage(slots);
        await supabase.from("conversations").insert({ lead_id: lead.id, direction: "outbound", message: slotText, canal: "whatsapp" });
        decision.message = null;
      } else {
        // Fallback to text
        decision.message = ghl.formatSlotsMessage(slots);
      }
    } else {
      decision.message = "En este momento no veo huecos disponibles. ¿Te contacto cuando haya uno?";
    }
    decision.action = "send_message";
  }

  if (decision.action === "ask_availability") {
    // Sara already generated a message asking when they can. Just send it.
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

  if (decision.action === "cancel_appointment") {
    const { data: appt } = await supabase
      .from("appointments")
      .select("*")
      .eq("lead_id", lead.id)
      .eq("status", "scheduled")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (appt?.ghl_appointment_id) {
      await ghl.cancelAppointment(clinic.ghl_api_key, appt.ghl_appointment_id);
      await supabase.from("appointments").update({ status: "cancelled" }).eq("id", appt.id);
    }
    await supabase.from("leads").update({ status: "CALIFICADO" }).eq("id", lead.id);
    decision.status_update = "CALIFICADO";
    decision.action = "send_message";
  }

  if (decision.action === "reschedule_appointment") {
    const { data: appt } = await supabase
      .from("appointments")
      .select("*")
      .eq("lead_id", lead.id)
      .eq("status", "scheduled")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (appt?.ghl_appointment_id) {
      await ghl.cancelAppointment(clinic.ghl_api_key, appt.ghl_appointment_id);
      await supabase.from("appointments").update({ status: "cancelled" }).eq("id", appt.id);
    }
    await supabase.from("leads").update({ status: "CALIFICADO" }).eq("id", lead.id);
    decision.status_update = "CALIFICADO";
    // Show new slots
    const slotsResult = await ghl.getFreeSlots(clinic.ghl_api_key, clinic.ghl_calendar_id, clinic.clinic_timezone || "Europe/Madrid");
    const slots = ghl.extractSlots(slotsResult.data);
    if (slots.length > 0) {
      decision.message = (decision.message ? decision.message + " ||| " : "") + ghl.formatSlotsMessage(slots);
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
  let qualificationUpdated = false;
  if (decision.qualification_updates) {
    const updates = Object.fromEntries(
      Object.entries(decision.qualification_updates).filter(([, v]) => v !== null && v !== undefined)
    );
    if (Object.keys(updates).length > 0) {
      await supabase.from("lead_qualification").upsert(
        { lead_id: lead.id, ...updates },
        { onConflict: "lead_id" }
      );
      qualificationUpdated = true;
    }
  }

  // Sync qualification to GHL contact description
  if (qualificationUpdated) {
    const { data: q } = await supabase
      .from("lead_qualification")
      .select("*")
      .eq("lead_id", lead.id)
      .single();
    if (q) {
      const desc = [
        q.treatment_type ? `Tratamiento: ${q.treatment_type}` : null,
        q.insurance_name ? `Seguro: ${q.insurance_name}` : null,
        q.urgency_score ? `Urgencia: ${q.urgency_score}/5` : null,
        q.availability_notes ? `Disponibilidad: ${q.availability_notes}` : null,
        q.price_objection ? `Objeción precio: sí` : null,
      ].filter(Boolean).join(" | ");
      await ghl.updateContact(clinic.ghl_api_key, contactId, { description: desc });
    }
  }
}
