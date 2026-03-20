/**
 * cron/recovery.js
 * Vercel cron — se ejecuta 2 veces al día (9:00 y 18:00).
 * Hace seguimiento a leads que no han respondido.
 *
 * Lógica:
 *   Step 0 → 1: sin respuesta 2h después del primer mensaje
 *   Step 1 → 2: sin respuesta 24h después
 *   Step 2 → 3: sin respuesta 72h después → PERDIDO
 */

const { getSupabase } = require("../../lib/supabase");
const { sendMessage } = require("../../lib/ghl");

const DELAYS_HOURS = [2, 24, 72]; // tiempo mínimo entre intentos

const MESSAGES = [
  (name, treatment) =>
    `Hola${name ? " " + name : ""}! Vi que no hemos podido conectar. ¿Sigues interesado en ${treatment || "nuestros servicios dentales"}? Estoy aquí para ayudarte 😊`,
  (name) =>
    `Hola${name ? " " + name : ""}! Soy Sara. Solo quería saber si tienes alguna duda o necesitas más información antes de dar el siguiente paso.`,
  (name, treatment) =>
    `Hola${name ? " " + name : ""}, último mensaje de mi parte. Si en algún momento necesitas ayuda con ${treatment || "tu salud dental"}, aquí estaremos. ¡Cuídate! 🦷`,
];

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const supabase = getSupabase();
  const now = new Date();
  let processed = 0;

  // Leads en estado CONTACTADO, CALIFICADO o RECUPERACION con recovery_step < 3
  const { data: leads } = await supabase
    .from("leads")
    .select("*, lead_qualification(*), clinics(name, ghl_api_key, ghl_location_id)")
    .in("status", ["CONTACTADO", "CALIFICADO", "RECUPERACION"])
    .eq("do_not_contact", false)
    .lt("recovery_step", 3);

  for (const lead of leads || []) {
    const clinic = lead.clinics;
    if (!clinic || !lead.ghl_contact_id) continue;

    // Obtener timestamp del último mensaje outbound
    const { data: lastOut } = await supabase
      .from("conversations")
      .select("created_at")
      .eq("lead_id", lead.id)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!lastOut) continue;

    // Obtener timestamp del último mensaje inbound
    const { data: lastIn } = await supabase
      .from("conversations")
      .select("created_at")
      .eq("lead_id", lead.id)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Si hubo respuesta después del último outbound → no recuperar
    if (lastIn && new Date(lastIn.created_at) > new Date(lastOut.created_at)) continue;

    const hoursSinceLastOut = (now - new Date(lastOut.created_at)) / (1000 * 60 * 60);
    const step = lead.recovery_step || 0;
    const requiredHours = DELAYS_HOURS[step];

    if (hoursSinceLastOut < requiredHours) continue;

    const nextStep = step + 1;

    if (nextStep > 3) {
      // Marcar como PERDIDO
      await supabase.from("leads").update({ status: "PERDIDO" }).eq("id", lead.id);
      continue;
    }

    const name = lead.name ? lead.name.split(" ")[0] : "";
    const treatment = lead.lead_qualification?.[0]?.treatment_type || "";
    const msg = MESSAGES[step](name, treatment);

    await sendMessage(clinic.ghl_api_key, lead.ghl_contact_id, clinic.ghl_location_id, msg);

    await supabase.from("conversations").insert({
      lead_id: lead.id,
      direction: "outbound",
      message: msg,
      canal: "whatsapp",
    });

    await supabase.from("leads").update({
      recovery_step: nextStep,
      status: nextStep >= 3 ? "PERDIDO" : "RECUPERACION",
    }).eq("id", lead.id);

    processed++;
  }

  console.log(`Recovery cron: ${processed} mensajes enviados`);
  res.status(200).json({ ok: true, processed });
};
