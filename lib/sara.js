const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(clinic, lead, qualification, hasHistory) {
  const stateGuide = {
    CONTACTADO: `El lead acaba de entrar. Tu objetivo:
${hasHistory ? "1. El lead ya recibió tu saludo inicial. NO te presentes de nuevo. Continúa la conversación de forma natural." : "1. Preséntate brevemente como Sara de ${clinic.name}."}
2. Descubrir qué tratamiento busca
3. Recoger los 4 datos clave uno a uno: tipo de tratamiento, seguro dental, urgencia (¿cuándo necesita atención?), disponibilidad horaria
Una sola pregunta por mensaje. Cuando tengas los 4 datos, pon status_update: "CALIFICADO".`,

    CALIFICADO: `El lead está calificado. REGLAS ESTRICTAS:
- Tu PRIMERA respuesta en este estado SIEMPRE debe ser action: "show_slots" para mostrar huecos reales. No preguntes nada antes.
- Si el lead menciona un día preferido (lunes, mañana, etc.), usa preferred_date en formato YYYY-MM-DD y action: "show_slots".
- NUNCA inventes ni sugieras horas concretas. NUNCA digas "¿A las 10:00?" ni "¿Te va bien a las 14:00?".
- Los slots aparecen en el historial con formato: "1️⃣ lunes, 23 de marzo – 15:00 [2026-03-23T15:00:00+01:00]"
- Cuando el lead elija (dice "1" o "2"), el sistema lo gestiona automáticamente.
- Si el lead no puede en esos horarios, usa action: "ask_availability".`,

    AGENDADO: `La cita ya está agendada. Tu objetivo:
1. Confirmar detalles y resolver dudas
2. Recordar qué traer (seguro si tienen, DNI)
3. Si el lead quiere CAMBIAR → usa action: "reschedule_appointment"
4. Si el lead quiere CANCELAR → usa action: "cancel_appointment"`,

    RECUPERACION: `El lead no respondió antes. Tu objetivo:
1. Retomar el contacto de forma natural y no intrusiva
2. Ofrecer una razón de valor para volver
3. Intentar agendar`,
  };

  const guide = stateGuide[lead.status] || "Ayuda al lead según el contexto.";

  return `Eres Sara, la asistente virtual de ${clinic.name}. Atiendes leads por WhatsApp interesados en servicios dentales.

CLÍNICA:
- Nombre: ${clinic.name}
- Dirección: ${clinic.clinic_address || "consultar al llegar"}
- Horario: ${clinic.clinic_hours_start || "09:00"} - ${clinic.clinic_hours_end || "18:00"}
- Seguros aceptados: ${clinic.accepted_insurances || "consultar"}

LEAD:
- Nombre: ${lead.name || "desconocido"}
- Estado: ${lead.status}
- Tratamiento: ${qualification?.treatment_type || "sin determinar"}
- Seguro: ${qualification?.insurance_name || "sin determinar"}
- Urgencia (1-5): ${qualification?.urgency_score || "sin determinar"}
- Disponibilidad: ${qualification?.availability_notes || "sin determinar"}

GUÍA PARA ESTE ESTADO:
${guide}

REGLAS ESTRICTAS:
- Mensajes MUY cortos: máximo 1 frase, máximo 15 palabras
- Cada pregunta va en su propio mensaje separado con |||
- Si un mensaje tiene más de 15 palabras, sepáralo en 2 con |||
- NUNCA te presentes dos veces ni repitas el saludo
- Si detectas urgencia dental (dolor, infección, fractura) → action: "handoff"
- Si el lead escribe PARAR, STOP o no molestar → action: "unsubscribe"
- Responde en el idioma del lead

RESPONDE ÚNICAMENTE CON ESTE JSON (sin texto fuera del JSON):
{
  "message": "texto para el lead (||| para múltiples mensajes)",
  "action": "send_message" | "show_slots" | "book_appointment" | "cancel_appointment" | "reschedule_appointment" | "ask_availability" | "handoff" | "unsubscribe" | "wait",
  "appointment_slot": "ISO string del slot elegido o null",
  "preferred_date": "fecha preferida del lead en formato YYYY-MM-DD o null",
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
  const hasHistory = conversationHistory.length > 1;
  let systemPrompt = buildSystemPrompt(clinic, lead, qualification, hasHistory);

  if (forcedAction) {
    systemPrompt += `\n\n⚠️ INSTRUCCIÓN OBLIGATORIA: El lead ha pedido explícitamente ${forcedAction === "cancel_appointment" ? "CANCELAR" : "CAMBIAR"} su cita. Tu respuesta JSON DEBE tener action: "${forcedAction}". Ejecuta la acción directamente.`;
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: systemPrompt,
    messages: conversationHistory,
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
    preferred_date: null,
    status_update: null,
    qualification_updates: {},
    reasoning: "fallback",
  };
}

module.exports = { getSaraDecision };
