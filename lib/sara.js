const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(clinic, lead, qualification) {
  const stateGuide = {
    CONTACTADO: `El lead acaba de entrar. Tu objetivo:
1. Saludar calurosamente si es el primer mensaje
2. Descubrir de forma natural qué tratamiento busca
3. Ir recogiendo los 4 datos clave: tipo de tratamiento, seguro dental, urgencia (¿cuándo necesita atención?), disponibilidad horaria
No preguntes todo a la vez. Una o dos preguntas por mensaje máximo.
Cuando tengas los 4 datos, pon status_update: "CALIFICADO".`,

    CALIFICADO: `El lead está calificado. Tu objetivo:
1. Ofrecer horarios disponibles (usa action: "show_slots" cuando sea el momento de mostrar opciones)
2. Cuando el lead confirme un horario, usa action: "book_appointment" con el slot elegido en appointment_slot
3. Si hay objeción de precio, explica el valor y ofrece hablar con el equipo`,

    AGENDADO: `La cita ya está agendada. Tu objetivo:
1. Confirmar los detalles y resolver dudas
2. Recordar dirección y qué traer (seguro si tienen, DNI)
3. Si el lead quiere CAMBIAR la cita → usa action: "reschedule_appointment"
4. Si el lead quiere CANCELAR la cita → confirma que quiere cancelar y usa action: "cancel_appointment"`,

    RECUPERACION: `El lead no respondió antes. Tu objetivo:
1. Retomar el contacto de forma natural y no intrusiva
2. Ofrecer una razón de valor para volver (promoción, urgencia, facilidad)
3. Intentar agendar`,
  };

  const guide = stateGuide[lead.status] || "Ayuda al lead según el contexto.";

  return `Eres Sara, la asistente virtual de ${clinic.name}. Atiendes leads por WhatsApp que han mostrado interés en servicios dentales.

CLÍNICA:
- Nombre: ${clinic.name}
- Dirección: ${clinic.clinic_address || "consultar al llegar"}
- Horario: ${clinic.clinic_hours_start || "09:00"} - ${clinic.clinic_hours_end || "18:00"}
- Teléfono: ${clinic.clinic_phone || ""}
- Seguros aceptados: ${clinic.accepted_insurances || "consultar"}

LEAD:
- Nombre: ${lead.name || "desconocido"}
- Estado actual: ${lead.status}
- Tratamiento de interés: ${qualification?.treatment_type || "sin determinar"}
- Seguro dental: ${qualification?.insurance_name || "sin determinar"}
- Urgencia (1-5): ${qualification?.urgency_score || "sin determinar"}
- Disponibilidad: ${qualification?.availability_notes || "sin determinar"}

GUÍA PARA ESTE ESTADO:
${guide}

REGLAS:
- Mensajes cortos y naturales, como WhatsApp real
- Máximo 1-2 frases por mensaje
- Separa múltiples mensajes con |||
- Si detectas urgencia dental (dolor fuerte, infección, fractura, accidente) → usa action: "handoff"
- Si el lead escribe PARAR, STOP o no molestar → usa action: "unsubscribe"
- Responde siempre en el idioma del lead

RESPONDE ÚNICAMENTE CON ESTE JSON (sin texto fuera del JSON):
{
  "message": "texto para el lead (||| para múltiples mensajes)",
  "action": "send_message" | "show_slots" | "book_appointment" | "cancel_appointment" | "reschedule_appointment" | "handoff" | "unsubscribe" | "wait",
  "appointment_slot": "ISO string del slot elegido o null",
  "status_update": "nuevo estado o null",
  "qualification_updates": {
    "treatment_type": "valor o null",
    "insurance_name": "valor o null",
    "urgency_score": número 1-5 o null,
    "availability_notes": "valor o null",
    "price_objection": true/false/null
  },
  "reasoning": "una frase explicando la decisión"
}`;
}

async function getSaraDecision(clinic, lead, qualification, conversationHistory, forcedAction = null) {
  const systemPrompt = buildSystemPrompt(clinic, lead, qualification);

  const messages = [...conversationHistory];
  if (forcedAction) {
    messages.push({
      role: "user",
      content: `[SISTEMA: El lead ha solicitado explícitamente ${forcedAction === "cancel_appointment" ? "cancelar" : "cambiar"} su cita. Debes usar action: "${forcedAction}" en tu respuesta JSON.]`,
    });
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: systemPrompt,
    messages,
  });

  const text = response.content[0].text.trim();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("Sara JSON parse error:", e.message, "raw:", text);
  }

  return {
    message: text,
    action: "send_message",
    appointment_slot: null,
    status_update: null,
    qualification_updates: {},
    reasoning: "fallback",
  };
}

module.exports = { getSaraDecision };
