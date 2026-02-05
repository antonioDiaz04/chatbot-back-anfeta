import HistorialBot from "../models/historialBot.model.js";

/**
 * Guarda un mensaje dentro de una conversación
 * ✅ CREA la sesión si no existe
 * ✅ ACTUALIZA la sesión si ya existe
 */
export async function guardarMensajeHistorial({
  userId,
  sessionId,
  role,
  contenido,
  tipoMensaje = "texto",
  analisis = null,
  estadoConversacion = null
}) {
  if (!userId || !sessionId || !role || !contenido) {
    throw new Error("Faltan datos para guardar mensaje en historial");
  }

  const nuevoMensaje = {
    role,
    contenido,
    tipoMensaje,
    analisis,
    timestamp: new Date()
  };

  // ✅ Usar findOneAndUpdate con upsert para evitar race conditions
  const updateData = {
    $push: { mensajes: nuevoMensaje },
    $set: { updatedAt: new Date() }
  };

  // Solo actualizar estado si se proporciona
  if (estadoConversacion) {
    updateData.$set.estadoConversacion = estadoConversacion;
  }

  const resultado = await HistorialBot.findOneAndUpdate(
    { userId, sessionId },
    {
      ...updateData,
      $setOnInsert: {
        userId,
        sessionId,
        nombreConversacion: "Nueva conversación",
        tareasEstado: [],
        ultimoAnalisis: null,
        createdAt: new Date()
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    }
  );

  return resultado;
}