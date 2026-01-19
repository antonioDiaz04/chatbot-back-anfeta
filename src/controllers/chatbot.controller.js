import axios from "axios"
import Proyecto from "../models/Proyecto.js"
import Actividad from "../models/Actividad.js"

/**
 * Estado diario del chatbot
 * El usuario NO selecciona nada
 * Todo se obtiene automáticamente desde su sesión
 */
export const obtenerEstadoDiarioChatbot = async (req, res) => {
  try {
    // ✅ 1. Usuario obtenido desde el token
    const usuarioId = req.user.id
    const nombreUsuario = req.user.nombre

    // ✅ 2. Proyecto activo del usuario
    const proyecto = await Proyecto.findOne({
      usuario: usuarioId,
      activo: true
    })

    if (!proyecto) {
      return res.status(404).json({
        ok: false,
        mensaje: "No tienes un proyecto activo asignado"
      })
    }

    // ✅ 3. Actividades del proyecto
    const actividades = await Actividad.find({
      proyecto: proyecto._id
    })

    // ✅ 4. Obtener revisiones por cada actividad
    const actividadesConRevisiones = await Promise.all(
      actividades.map(async (actividad) => {
        let revisiones = []

        try {
          const response = await axios.get(
            `https://wlserver-production.up.railway.app/api/revisions/actividad/${actividad._id}`
          )
          revisiones = response.data
        } catch (error) {
          console.error(
            `Error al obtener revisiones de la actividad ${actividad._id}`
          )
        }

        return {
          id: actividad._id,
          nombre: actividad.nombre,
          estado: actividad.estado,
          fecha: actividad.fecha,
          revisiones
        }
      })
    )

    // ✅ 5. Respuesta final para el chatbot
    return res.json({
      ok: true,
      asistente: {
        mensaje: `Buenos días ${nombreUsuario}, este es tu estado actual`,
        usuario: nombreUsuario,
        proyecto: {
          id: proyecto._id,
          nombre: proyecto.nombre
        },
        actividades: actividadesConRevisiones
      }
    })

  } catch (error) {
    console.error("Error en obtenerEstadoDiarioChatbot:", error)
    return res.status(500).json({
      ok: false,
      mensaje: "Error interno del servidor"
    })
  }
}
