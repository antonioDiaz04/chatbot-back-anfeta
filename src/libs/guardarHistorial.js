import HistorialBot from "../models/historialBot.mode";

/**
 * Guarda un mensaje en el historial del bot.
 * @param {String} userId - ID del usuario
 * @param {String} sessionId - ID de la sesión actual
 * @param {String} role - 'usuario' o 'bot'
 * @param {String} contenido - Contenido del mensaje
 * @returns {Promise<Object>} - El documento actualizado
 */
export async function guardarMensajeHistorial(userId, sessionId, role, contenido) {
  if (!userId || !sessionId || !role || !contenido) {
    throw new Error("Faltan datos requeridos para guardar el mensaje");
  }

  // Guardar el mensaje en MongoDB
  const registro = await HistorialBot.findOneAndUpdate(
    { userId, sessionId },
    { 
      $push: { mensajes: { role, contenido, timestamp: new Date() } } 
    },
    { new: true, upsert: true } // crea el documento si no existe
  );

  return registro;
}
