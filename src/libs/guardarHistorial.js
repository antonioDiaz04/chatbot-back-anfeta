// Agregar estas funciones helper en tu controlador o en un archivo separado

/**
 * Guarda o actualiza el historial de conversación
 */
async function guardarMensajeHistorial(userId, sessionId, mensaje, analisis = null) {
  try {
    const nuevoMensaje = {
      role: mensaje.role, // "usuario" o "bot"
      contenido: mensaje.contenido,
      timestamp: new Date(),
      tipoMensaje: mensaje.tipoMensaje || "texto",
      analisis: analisis
    };

    const historial = await HistorialBot.findOneAndUpdate(
      { userId, sessionId },
      {
        $push: { mensajes: nuevoMensaje },
        $set: { 
          ultimoAnalisis: analisis,
          estadoConversacion: mensaje.estadoConversacion || "esperando_usuario"
        }
      },
      { upsert: true, new: true }
    );

    return historial;
  } catch (error) {
    console.error("Error guardando mensaje en historial:", error);
    throw error;
  }
}

/**
 * Actualiza el estado de las tareas en el historial
 */
async function actualizarEstadoTareas(userId, sessionId, tareas) {
  try {
    return await HistorialBot.findOneAndUpdate(
      { userId, sessionId },
      { $set: { tareasEstado: tareas } },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error("Error actualizando estado de tareas:", error);
    throw error;
  }
}