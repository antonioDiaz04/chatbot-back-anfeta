import axios from 'axios';
import { getAllUsers } from './users.controller.js';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { smartAICall } from '../libs/aiService.js';
import ActividadPendientes from "../models/actividades.model.js";
import HistorialBot from "../models/historialBot.model.js";

const urlApi = 'https://wlserver-production.up.railway.app/api';

// Almacenamiento en memoria para conversaciones (en producción usarías Redis o DB)
const conversaciones = new Map();

// Función auxiliar
function horaAMinutos(hora) {
  if (!hora) return null;
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Guarda un mensaje en el historial del bot (MongoDB).
 * @param {String} odooUserId - ID del usuario en Odoo
 * @param {String} sessionId - ID de la sesión actual
 * @param {String} role - 'usuario' o 'bot'
 * @param {String} contenido - Contenido del mensaje
 * @returns {Promise<Object>} - El documento actualizado
 */
async function guardarMensajeHistorial(odooUserId, sessionId, role, contenido) {
  try {
    if (!odooUserId || !sessionId || !role || !contenido) {
      console.warn("Faltan datos para guardar en historial:", { odooUserId, sessionId, role, contenido: contenido?.substring(0, 50) });
      return null;
    }

    const registro = await HistorialBot.findOneAndUpdate(
      { odooUserId, sessionId },
      {
        $push: { mensajes: { role, contenido, timestamp: new Date() } },
        $setOnInsert: { odooUserId, sessionId }
      },
      { new: true, upsert: true }
    );

    return registro;
  } catch (error) {
    console.error("Error guardando mensaje en historial:", error.message);
    return null;
  }
}


/**
 * Sistema de conversación interactiva con historial - MEJORADO para manejar sugerencias
 */
export async function chatInteractivo(req, res) {
  try {
    const { email, message, sessionId = `session_${Date.now()}` } = sanitizeObject(req.body);

    if (!email || !message) {
      return res.status(400).json({
        success: false,
        message: "Email y mensaje son requeridos"
      });
    }

    // Obtener usuario para el historial
    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado"
      });
    }

    const odooUserId = user.id || user._id || email;

    // 1. Obtener o crear contexto de conversación
    if (!conversaciones.has(sessionId)) {
      conversaciones.set(sessionId, {
        odooUserId: odooUserId,
        email: email,
        historial: [],
        datosActividades: null,
        ultimaConsulta: null,
        timestamp: Date.now(),
        estado: 'inicio',
        ultimasSugerencias: []
      });
    }

    const contexto = conversaciones.get(sessionId);
    limpiarConversacionesAntiguas();

    // 2. Agregar mensaje del usuario al historial en memoria
    contexto.historial.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
      esConsultaActividades: false
    });

    // ✅ Guardar mensaje del usuario en MongoDB
    await guardarMensajeHistorial(odooUserId, sessionId, "usuario", message);

    // 3. Detectar tipo de mensaje
    const palabrasClaveActividades = [
      'actividad', 'tarea', 'pendiente', 'hoy', 'revisión', 'revisar',
      'qué tengo', 'qué hacer', 'trabajo', 'proyecto', 'jornada',
      'mañana', 'tarde', 'dia', 'día', 'plan', 'organizar',
      'priorizar', 'tiempo', 'horario', 'agenda', 'calendario'
    ];

    const mensajeLower = message.toLowerCase();
    const esConsultaActividades = palabrasClaveActividades.some(palabra =>
      mensajeLower.includes(palabra)
    ) ||
      mensajeLower.includes('?') && (
        mensajeLower.includes('qué') ||
        mensajeLower.includes('cómo') ||
        mensajeLower.includes('cuándo') ||
        mensajeLower.includes('cuanto') ||
        mensajeLower.includes('cuál')
      );

    // Actualizar historial con el tipo de consulta
    contexto.historial[contexto.historial.length - 1].esConsultaActividades = esConsultaActividades;

    // 4. Manejar consulta de actividades o conversación normal
    let respuesta;

    if (esConsultaActividades || !contexto.datosActividades || contexto.estado === 'inicio') {
      // Obtener y procesar actividades
      const resultadoActividades = await obtenerYProcesarActividades(email, message, sessionId);

      // Guardar datos en contexto
      contexto.datosActividades = {
        actividades: resultadoActividades.data.actividades,
        revisionesPorActividad: resultadoActividades.data.revisionesPorActividad,
        metrics: resultadoActividades.metrics,
        proyectoPrincipal: resultadoActividades.proyectoPrincipal
      };
      contexto.ultimaConsulta = new Date().toISOString();
      contexto.estado = 'tiene_datos';
      contexto.ultimasSugerencias = resultadoActividades.sugerencias || [];

      // Agregar respuesta al historial en memoria
      contexto.historial.push({
        role: 'assistant',
        content: resultadoActividades.answer,
        timestamp: new Date().toISOString(),
        tipo: 'actividades',
        datosDisponibles: true
      });

      // ✅ Guardar respuesta del bot en MongoDB
      await guardarMensajeHistorial(odooUserId, sessionId, "bot", resultadoActividades.answer);

      respuesta = {
        success: true,
        answer: resultadoActividades.answer,
        provider: resultadoActividades.provider,
        sessionId: sessionId,
        proyectoPrincipal: resultadoActividades.proyectoPrincipal,
        metrics: resultadoActividades.metrics,
        data: resultadoActividades.data,
        separadasPorTiempo: true,
        sugerencias: resultadoActividades.sugerencias,
        sugerenciasConIndices: (resultadoActividades.sugerencias || []).map((sug, index) => ({
          id: index,
          text: sug,
          type: determinarTipoSugerencia(sug)
        })),
        contexto: {
          tieneDatos: true,
          estado: contexto.estado,
          historialCount: contexto.historial.length,
          ultimaConsulta: contexto.ultimaConsulta
        }
      };

    } else {
      // Conversación normal (seguimiento)
      const promptContexto = construirPromptContexto(contexto, message);
      const aiResult = await smartAICall(promptContexto);

      // Guardar respuesta en historial en memoria
      contexto.historial.push({
        role: 'assistant',
        content: aiResult.text,
        timestamp: new Date().toISOString(),
        tipo: 'conversacion'
      });

      // ✅ Guardar respuesta del bot en MongoDB
      await guardarMensajeHistorial(odooUserId, sessionId, "bot", aiResult.text);

      // Actualizar estado
      contexto.estado = determinarNuevoEstado(aiResult.text, contexto);

      // Generar nuevas sugerencias
      const nuevasSugerencias = generarSugerencias(contexto.estado, contexto);
      contexto.ultimasSugerencias = nuevasSugerencias;

      respuesta = {
        success: true,
        answer: aiResult.text,
        provider: aiResult.provider,
        sessionId: sessionId,
        contexto: {
          tieneDatos: contexto.datosActividades !== null,
          estado: contexto.estado,
          historialCount: contexto.historial.length,
          ultimaConsulta: contexto.ultimaConsulta
        },
        sugerencias: nuevasSugerencias,
        sugerenciasConIndices: nuevasSugerencias.map((sug, index) => ({
          id: index,
          text: sug,
          type: determinarTipoSugerencia(sug)
        }))
      };

      // Incluir datos si el usuario los pidió específicamente
      if (mensajeLower.includes('datos') || mensajeLower.includes('información') ||
        mensajeLower.includes('detalles') || mensajeLower.includes('métrica')) {
        respuesta.data = {
          actividades: contexto.datosActividades.actividades,
          revisiones: contexto.datosActividades.revisionesPorActividad,
          metrics: contexto.datosActividades.metrics
        };
        respuesta.proyectoPrincipal = contexto.datosActividades.proyectoPrincipal;
        respuesta.metrics = contexto.datosActividades.metrics;
      }
    }

    return res.json(respuesta);

  } catch (error) {
    console.error("Error en chatInteractivo:", error);

    if (error.message === "AI_PROVIDER_FAILED") {
      return res.status(503).json({
        success: false,
        message: "El asistente está muy ocupado en este momento. ¡Danos un minuto y vuelve a intentarlo!",
        sessionId: req.body.sessionId || `error_${Date.now()}`
      });
    }

    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "El asistente está temporalmente saturado. Intenta nuevamente en unos minutos.",
        sessionId: req.body.sessionId || `error_${Date.now()}`
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
      sessionId: req.body.sessionId || `error_${Date.now()}`
    });
  }
}

async function obtenerYProcesarActividades(email, question, sessionId) {
  try {
    const showAll = question.toLowerCase().includes("todos") ||
      question.toLowerCase().includes("todas") ||
      question.toLowerCase().includes("otros horarios");

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Obtener actividades del día
    const actividadesResponse = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = actividadesResponse.data.data;

    if (!Array.isArray(actividadesRaw) || actividadesRaw.length === 0) {
      return {
        answer: "No tienes actividades registradas para hoy",
        provider: "system",
        proyectoPrincipal: "Sin proyecto",
        metrics: {
          totalActividades: 0,
          tareasConTiempo: 0,
          tareasSinTiempo: 0,
          tareasAltaPrioridad: 0,
          tiempoEstimadoTotal: "0h 0m"
        },
        data: {
          actividades: [],
          revisionesPorActividad: []
        },
        sugerencias: [
          "¿Quieres revisar actividades de otro día?",
          "¿Necesitas ayuda para crear nuevas actividades?",
          "¿Tienes proyectos pendientes sin asignar?"
        ]
      };
    }

    // 🔍 OBTENER PROYECTO PRINCIPAL
    const actividadPrincipal = actividadesRaw.find(a =>
      a.horaInicio === '09:30' && a.horaFin === '16:30'
    );

    let proyectoPrincipal = "Sin proyecto específico";
    if (actividadPrincipal) {
      if (actividadPrincipal.tituloProyecto && actividadPrincipal.tituloProyecto !== "Sin proyecto") {
        proyectoPrincipal = actividadPrincipal.tituloProyecto;
      } else if (actividadPrincipal.titulo) {
        const tituloLimpio = actividadPrincipal.titulo
          .replace('analizador de pendientes 00act', '')
          .replace('anfeta', '')
          .trim();
        proyectoPrincipal = tituloLimpio || actividadPrincipal.titulo.substring(0, 50) + "...";
      }
    }

    // FILTRAR actividades
    let actividadesFiltradas = [];
    let mostrarSoloConTiempo = true;

    if (showAll) {
      actividadesFiltradas = actividadesRaw;
      mostrarSoloConTiempo = false;
    } else {
      actividadesFiltradas = actividadesRaw.filter((a) => {
        return a.horaInicio === '09:30' && a.horaFin === '16:30';
      });
    }

    // Si no hay actividades en horario principal pero sí hay otras
    if (actividadesFiltradas.length === 0 && actividadesRaw.length > 0) {
      actividadesFiltradas = actividadesRaw;
      mostrarSoloConTiempo = false;
    }

    // Extraer IDs de actividades
    const actividadIds = actividadesFiltradas.map(a => a.id);

    // Obtener revisiones del día
    const today = new Date();
    const formattedToday = today.toISOString().split('T')[0];

    let todasRevisiones = { colaboradores: [] };
    try {
      const revisionesResponse = await axios.get(
        `${urlApi}/reportes/revisiones-por-fecha`,
        {
          params: {
            date: formattedToday,
            colaborador: email
          }
        }
      );

      if (revisionesResponse.data?.success) {
        todasRevisiones = revisionesResponse.data.data || { colaboradores: [] };
      }
    } catch (error) {
      console.warn("Error obteniendo revisiones:", error.message);
    }

    // 4️⃣ Organizar revisiones por actividad
    const revisionesPorActividad = {};

    actividadesFiltradas.forEach(actividad => {
      revisionesPorActividad[actividad.id] = {
        actividad: {
          id: actividad.id,
          titulo: actividad.titulo,
          horaInicio: actividad.horaInicio,
          horaFin: actividad.horaFin,
          status: actividad.status,
          proyecto: actividad.tituloProyecto
        },
        pendientesConTiempo: [],
        pendientesSinTiempo: []
      };
    });

    // Procesar revisiones - SEPARAR por tiempo
    if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
      todasRevisiones.colaboradores.forEach(colaborador => {
        (colaborador.items?.actividades ?? []).forEach(actividad => {
          if (actividadIds.includes(actividad.id) && actividad.pendientes) {
            (actividad.pendientes ?? []).forEach(p => {
              const estaAsignado = p.assignees?.some(a => a.name === email);
              if (!estaAsignado) return;

              const pendienteInfo = {
                id: p.id,
                nombre: p.nombre,
                terminada: p.terminada,
                confirmada: p.confirmada,
                duracionMin: p.duracionMin || 0,
                fechaCreacion: p.fechaCreacion,
                fechaFinTerminada: p.fechaFinTerminada,
                diasPendiente: p.fechaCreacion ?
                  Math.floor((new Date() - new Date(p.fechaCreacion)) / (1000 * 60 * 60 * 24)) : 0
              };

              // SEPARAR por tiempo
              if (p.duracionMin && p.duracionMin > 0) {
                pendienteInfo.prioridad = p.duracionMin > 60 ? "ALTA" :
                  p.duracionMin > 30 ? "MEDIA" : "BAJA";
                revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);
              } else {
                pendienteInfo.prioridad = "SIN TIEMPO";
                revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
              }
            });
          }
        });
      });
    }

    // 5️⃣ Calcular métricas
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0;
    let tareasAltaPrioridad = 0;
    let tiempoTotalEstimado = 0;

    Object.keys(revisionesPorActividad).forEach(actividadId => {
      const actividad = revisionesPorActividad[actividadId];
      totalTareasConTiempo += actividad.pendientesConTiempo.length;
      totalTareasSinTiempo += actividad.pendientesSinTiempo.length;
      tareasAltaPrioridad += actividad.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length;
      tiempoTotalEstimado += actividad.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;
    const totalTareas = totalTareasConTiempo + totalTareasSinTiempo;

    // 6️⃣ Construir prompt para IA
    let prompt = "";

    if (showAll || !mostrarSoloConTiempo) {
      // Prompt para mostrar TODAS
      prompt = `
Eres un asistente que analiza todas las actividades del día.
Usuario: ${user.firstName} (${email})
Proyecto principal asignado: "${proyectoPrincipal}"

Contexto: Mostrando todas las actividades del día.

Total actividades: ${actividadesFiltradas.length}
Total tareas: ${totalTareas} (${totalTareasConTiempo} con tiempo, ${totalTareasSinTiempo} sin tiempo)
Tiempo estimado: ${horasTotales}h ${minutosTotales}m

PROYECTO PRINCIPAL:
"${proyectoPrincipal}"

DETALLE DE ACTIVIDADES:
${actividadesFiltradas.map((actividad, index) => {
        const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
        const conTiempo = revisiones.pendientesConTiempo;
        const sinTiempo = revisiones.pendientesSinTiempo;
        const esPrincipal = actividad.horaInicio === '09:30' && actividad.horaFin === '16:30';
        const indicadorPrincipal = esPrincipal ? " [PROYECTO PRINCIPAL]" : "";

        let actividadTexto = `
${index + 1}. ${actividad.horaInicio} - ${actividad.horaFin} - ${actividad.titulo}${indicadorPrincipal}
   • Proyecto: ${actividad.tituloProyecto || "Sin proyecto"}
   • Estado: ${actividad.status}
   • Tareas: ${conTiempo.length + sinTiempo.length} (${conTiempo.length} con tiempo, ${sinTiempo.length} sin tiempo)`;

        if (conTiempo.length > 0) {
          actividadTexto += `
   • CON TIEMPO:`;
          conTiempo.forEach((tarea, i) => {
            actividadTexto += `
     ${i + 1}. ${tarea.nombre} - ${tarea.duracionMin}min (${tarea.prioridad}, ${tarea.diasPendiente}d)`;
          });
        }

        if (sinTiempo.length > 0) {
          actividadTexto += `
   • SIN TIEMPO:`;
          sinTiempo.forEach((tarea, i) => {
            actividadTexto += `
     ${i + 1}. ${tarea.nombre} (${tarea.diasPendiente}d pendiente)`;
          });
        }

        return actividadTexto;
      }).join('\n')}

PREGUNTA DEL USUARIO: "${question}"

INSTRUCCIONES DE RESPUESTA:
1. Comienza mencionando el proyecto principal
2. Da un resumen general de las actividades
3. Destaca las tareas más importantes o urgentes
4. Ofrece recomendaciones específicas
5. Haz una pregunta de seguimiento
6. Sé natural y directo
7. NO uses emojis
`.trim();
    } else {
      // Prompt solo para tareas con tiempo
      prompt = `
Eres un asistente que analiza actividades del día con tiempo asignado.
Usuario: ${user.firstName} (${email})
Proyecto principal: "${proyectoPrincipal}"

TAREAS CON TIEMPO ASIGNADO:
Total: ${totalTareasConTiempo} tareas | Tiempo total: ${horasTotales}h ${minutosTotales}m
Tareas alta prioridad: ${tareasAltaPrioridad}

${Object.values(revisionesPorActividad).flatMap(act =>
        act.pendientesConTiempo.map(r =>
          `• ${r.nombre} - ${r.duracionMin}min (${r.prioridad}, ${r.diasPendiente}d)`
        )
      ).join('\n')}

PREGUNTA: "${question}"

INSTRUCCIONES DE RESPUESTA:
1. Enfócate en el proyecto principal: "${proyectoPrincipal}"
2. Recomienda prioridades basadas en tiempo y urgencia
3. Sé conciso (máximo 4 líneas)
4. Termina con una pregunta sobre la siguiente acción
5. SIN emojis ni formato especial
`.trim();
    }

    // 7️⃣ Obtener respuesta de IA
    const aiResult = await smartAICall(prompt);

    // 8️⃣ Preparar datos estructurados
    const actividadesEstructuradas = actividadesFiltradas.map(a => ({
      id: a.id,
      titulo: a.titulo,
      horario: `${a.horaInicio} - ${a.horaFin}`,
      status: a.status,
      proyecto: a.tituloProyecto || "Sin proyecto",
      esPrincipal: a.horaInicio === '09:30' && a.horaFin === '16:30'
    }));

    const revisionesEstructuradas = Object.values(revisionesPorActividad)
      .filter(item => item.pendientesConTiempo.length > 0 || item.pendientesSinTiempo.length > 0)
      .map(item => ({
        actividadId: item.actividad.id,
        actividadTitulo: item.actividad.titulo,
        tareasConTiempo: item.pendientesConTiempo,
        tareasSinTiempo: item.pendientesSinTiempo,
        totalTareas: item.pendientesConTiempo.length + item.pendientesSinTiempo.length,
        tareasAltaPrioridad: item.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length,
        tiempoTotal: item.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0)
      }));

    // 9️⃣ Generar sugerencias contextuales
    let sugerencias = [];

    if (showAll || !mostrarSoloConTiempo) {
      sugerencias = [
        `¿Quieres estimar tiempo para las ${totalTareasSinTiempo} tareas sin tiempo?`,
        `¿Quieres priorizar las tareas de alta prioridad?`,
        "¿Necesitas ayuda para organizar tu día completo?",
        `¿Quieres enfocarte solo en el proyecto '${proyectoPrincipal.substring(0, 30)}...'?`,
        "¿Te ayudo a crear un horario detallado?"
      ];
    } else {
      sugerencias = [
        `¿Quieres profundizar en alguna tarea de '${proyectoPrincipal}'?`,
        `¿Necesitas ayuda para organizar las tareas por tiempo?`,
        "¿Quieres ver todas tus actividades del día?",
        `¿Te ayudo a distribuir el tiempo de las ${totalTareasConTiempo} tareas?`,
        "¿Hay alguna tarea específica que necesite más detalle?"
      ];
    }

    // 🔟 Retornar objeto estructurado
    return {
      answer: aiResult.text,
      provider: aiResult.provider,
      proyectoPrincipal: proyectoPrincipal,
      metrics: {
        totalActividades: actividadesFiltradas.length,
        tareasConTiempo: totalTareasConTiempo,
        tareasSinTiempo: totalTareasSinTiempo,
        tareasAltaPrioridad: tareasAltaPrioridad,
        tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`
      },
      data: {
        actividades: actividadesEstructuradas,
        revisionesPorActividad: revisionesEstructuradas
      },
      sugerencias: sugerencias.slice(0, 5),
      sessionId: sessionId
    };

  } catch (error) {
    console.error("Error en obtenerYProcesarActividades:", error);

    return {
      answer: "Lo siento, hubo un error al obtener tus actividades. Por favor, intenta de nuevo.",
      provider: "system",
      proyectoPrincipal: "Error",
      metrics: {
        totalActividades: 0,
        tareasConTiempo: 0,
        tareasSinTiempo: 0,
        tareasAltaPrioridad: 0,
        tiempoEstimadoTotal: "0h 0m"
      },
      data: {
        actividades: [],
        revisionesPorActividad: []
      },
      sugerencias: [
        "Intenta de nuevo en un momento",
        "Verifica que tu email sea correcto",
        "Contacta al administrador si el problema persiste"
      ],
      sessionId: sessionId
    };
  }
}

export async function getActividadesConRevisiones(req, res) {
  try {
    const { email, question = "¿Qué actividades y revisiones tengo hoy? ¿Qué me recomiendas priorizar?", showAll = false } = sanitizeObject(req.body);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "El email es requerido"
      });
    }
    const sessionId = `act_${email}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const odooUserId = user.id || user._id || email;

    // ✅ Guardar mensaje del usuario en historial
    await guardarMensajeHistorial(odooUserId, sessionId, "usuario", question);

    // 1️⃣ Obtener actividades del día para el usuario
    const actividadesResponse = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = actividadesResponse.data.data;

    if (!Array.isArray(actividadesRaw) || actividadesRaw.length === 0) {
      const respuestaSinActividades = "No tienes actividades registradas para hoy";

      // ✅ Guardar respuesta del bot en historial
      await guardarMensajeHistorial(odooUserId, sessionId, "bot", respuestaSinActividades);

      return res.json({
        success: true,
        answer: respuestaSinActividades,
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {}
      });
    }

    // 🔍 OBTENER PROYECTO PRINCIPAL (actividad 09:30-16:30) - DINÁMICO
    const actividadPrincipal = actividadesRaw.find(a =>
      a.horaInicio === '09:30' && a.horaFin === '16:30'
    );

    // Extraer el nombre del proyecto principal DINÁMICAMENTE
    let proyectoPrincipal = "Sin proyecto específico";
    if (actividadPrincipal) {
      if (actividadPrincipal.tituloProyecto && actividadPrincipal.tituloProyecto !== "Sin proyecto") {
        proyectoPrincipal = actividadPrincipal.tituloProyecto;
      } else if (actividadPrincipal.titulo) {
        // Intentar extraer del título
        const tituloLimpio = actividadPrincipal.titulo
          .replace('analizador de pendientes 00act', '')
          .replace('anfeta', '')
          .trim();
        proyectoPrincipal = tituloLimpio || actividadPrincipal.titulo.substring(0, 50) + "...";
      }
    }

    // FILTRAR según el parámetro showAll
    let actividadesFiltradas = [];
    let mensajeHorario = "";
    let mostrarSoloConTiempo = true;

    if (question.includes("otros horarios") || showAll) {
      // MOSTRAR TODAS las actividades del día
      actividadesFiltradas = actividadesRaw;
      mensajeHorario = "Mostrando todas las actividades del día";
      mostrarSoloConTiempo = false;
    } else {
      // Filtrar SOLO la actividad con horario 09:30-16:30
      actividadesFiltradas = actividadesRaw.filter((a) => {
        return a.horaInicio === '09:30' && a.horaFin === '16:30';
      });
      mensajeHorario = "Actividades en horario 09:30-16:30";

      if (actividadesFiltradas.length === 0) {
        const respuestaSinHorario = "No tienes actividades programadas en el horario de 09:30 a 16:30";

        // ✅ Guardar respuesta del bot en historial
        await guardarMensajeHistorial(odooUserId, sessionId, "bot", respuestaSinHorario);

        return res.json({
          success: true,
          answer: respuestaSinHorario,
          sessionId: sessionId,
          actividades: actividadesRaw.map(a => ({
            id: a.id,
            titulo: a.titulo,
            horario: `${a.horaInicio} - ${a.horaFin}`,
            status: a.status,
            proyecto: a.tituloProyecto || "Sin proyecto"
          })),
          revisionesPorActividad: {},
          proyectoPrincipal: proyectoPrincipal,
          sugerencias: [
            "¿Quieres ver todas tus actividades del día?",
            "¿Necesitas ayuda con actividades en otros horarios?",
            "¿Quieres que te ayude a planificar estas actividades?"
          ]
        });
      }
    }

    // 2️⃣ Extraer IDs de todas las actividades filtradas
    const actividadIds = actividadesFiltradas.map(a => a.id);

    // 3️⃣ Obtener fecha actual para las revisiones
    const today = new Date();
    const formattedToday = today.toISOString().split('T')[0];

    // 4️⃣ Obtener TODAS las revisiones del día
    let todasRevisiones = { colaboradores: [] };
    try {
      const revisionesResponse = await axios.get(
        `${urlApi}/reportes/revisiones-por-fecha`,
        {
          params: {
            date: formattedToday,
            colaborador: email
          }
        }
      );

      if (revisionesResponse.data?.success) {
        todasRevisiones = revisionesResponse.data.data || { colaboradores: [] };
      }
    } catch (error) {
      console.warn("Error obteniendo revisiones:", error.message);
    }

    // 5️⃣ Filtrar y organizar revisiones por actividad
    const revisionesPorActividad = {};
    const tareasConTiempo = {};
    const tareasSinTiempo = {};

    actividadesFiltradas.forEach(actividad => {
      revisionesPorActividad[actividad.id] = {
        actividad: {
          id: actividad.id,
          titulo: actividad.titulo,
          horaInicio: actividad.horaInicio,
          horaFin: actividad.horaFin,
          status: actividad.status,
          proyecto: actividad.tituloProyecto
        },
        pendientesConTiempo: [],
        pendientesSinTiempo: []
      };

      tareasConTiempo[actividad.id] = [];
      tareasSinTiempo[actividad.id] = [];
    });

    // Procesar revisiones - SEPARAR por tiempo
    if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
      todasRevisiones.colaboradores.forEach(colaborador => {
        (colaborador.items?.actividades ?? []).forEach(actividad => {
          if (actividadIds.includes(actividad.id) && actividad.pendientes) {
            (actividad.pendientes ?? []).forEach(p => {
              const estaAsignado = p.assignees?.some(a => a.name === email);
              if (!estaAsignado) return;

              const pendienteInfo = {
                id: p.id,
                nombre: p.nombre,
                terminada: p.terminada,
                confirmada: p.confirmada,
                duracionMin: p.duracionMin || 0,
                fechaCreacion: p.fechaCreacion,
                fechaFinTerminada: p.fechaFinTerminada,
                diasPendiente: p.fechaCreacion ?
                  Math.floor((new Date() - new Date(p.fechaCreacion)) / (1000 * 60 * 60 * 24)) : 0
              };

              // SEPARAR por tiempo
              if (p.duracionMin && p.duracionMin > 0) {
                pendienteInfo.prioridad = p.duracionMin > 60 ? "ALTA" :
                  p.duracionMin > 30 ? "MEDIA" : "BAJA";
                tareasConTiempo[actividad.id].push(pendienteInfo);
                revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);
              } else {
                pendienteInfo.prioridad = "SIN TIEMPO";
                tareasSinTiempo[actividad.id].push(pendienteInfo);
                revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
              }
            });
          }
        });
      });
    }

    // 6️⃣ Calcular métricas
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0;
    let tareasAltaPrioridad = 0;
    let tiempoTotalEstimado = 0;

    Object.keys(revisionesPorActividad).forEach(actividadId => {
      const actividad = revisionesPorActividad[actividadId];
      totalTareasConTiempo += actividad.pendientesConTiempo.length;
      totalTareasSinTiempo += actividad.pendientesSinTiempo.length;
      tareasAltaPrioridad += actividad.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length;
      tiempoTotalEstimado += actividad.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;
    const totalTareas = totalTareasConTiempo + totalTareasSinTiempo;

    // 7️⃣ Construir prompt según el tipo de análisis
    let prompt = "";

    if (question.includes("otros horarios") || showAll || !mostrarSoloConTiempo) {
      // Prompt para mostrar TODAS las actividades
      prompt = `
Eres un asistente que analiza todas las actividades del día.
Usuario: ${user.firstName} (${email})
Proyecto principal asignado: "${proyectoPrincipal}"

Contexto: Mostrando todas las actividades del día, incluyendo las que tienen y no tienen tiempo estimado.

${mensajeHorario}
Total actividades: ${actividadesFiltradas.length}
Total tareas: ${totalTareas} (${totalTareasConTiempo} con tiempo, ${totalTareasSinTiempo} sin tiempo)
Tiempo estimado de las tareas con tiempo: ${horasTotales}h ${minutosTotales}m

PROYECTO PRINCIPAL DEL DÍA (09:30-16:30):
"${proyectoPrincipal}"

DETALLE DE ACTIVIDADES:
${actividadesFiltradas.map((actividad, index) => {
        const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
        const conTiempo = revisiones.pendientesConTiempo;
        const sinTiempo = revisiones.pendientesSinTiempo;
        const esPrincipal = actividad.horaInicio === '09:30' && actividad.horaFin === '16:30';
        const indicadorPrincipal = esPrincipal ? " [PROYECTO PRINCIPAL]" : "";

        let actividadTexto = `
${index + 1}. ${actividad.horaInicio} - ${actividad.horaFin} - ${actividad.titulo}${indicadorPrincipal}
   • Proyecto: ${actividad.tituloProyecto || "Sin proyecto"}
   • Estado: ${actividad.status}
   • Total tareas: ${conTiempo.length + sinTiempo.length} (${conTiempo.length} con tiempo, ${sinTiempo.length} sin tiempo)`;

        if (conTiempo.length > 0) {
          actividadTexto += `
   • TAREAS CON TIEMPO:`;
          conTiempo.forEach((tarea, i) => {
            actividadTexto += `
     ${i + 1}. ${tarea.nombre}
        - ${tarea.duracionMin} min | Prioridad: ${tarea.prioridad} | Dias: ${tarea.diasPendiente}d`;
          });
        }

        if (sinTiempo.length > 0) {
          actividadTexto += `
   • TAREAS SIN TIEMPO:`;
          sinTiempo.forEach((tarea, i) => {
            actividadTexto += `
     ${i + 1}. ${tarea.nombre} (${tarea.diasPendiente}d pendiente)`;
          });
        }

        if (conTiempo.length === 0 && sinTiempo.length === 0) {
          actividadTexto += '\n   • Sin tareas asignadas';
        }

        return actividadTexto;
      }).join('\n')}

PREGUNTA DEL USUARIO: "${question}"

INSTRUCCIONES ESTRICTAS DE RESPUESTA:
1. COMIENZA mencionando el proyecto principal: "Tu proyecto principal es '${proyectoPrincipal}'"
2. Da un resumen general de todas las actividades mencionando el proyecto principal
3. Diles si están al día o menciona pendientes importantes del proyecto principal
4. Lista los puntos principales con viñetas relacionadas con el proyecto principal
5. Al final da sugerencias específicas: "Te recomiendo que empieces con [lista de tareas DEL PROYECTO PRINCIPAL] porque [razón]"
6. Pregunta si están de acuerdo con la sugerencia
7. Se natural y directo
8. NO uses emojis ni formato especial
9. Relaciona TODO con el proyecto principal

EJEMPLO DE RESPUESTA:
"Tu proyecto principal es '${proyectoPrincipal}'. Estás al día con 4 actividades hoy.
• Para tu proyecto principal tienes 4 tareas con tiempo asignado
• Hay 13 tareas sin tiempo que requieren estimación
• La tarea de alta prioridad está relacionada con el proyecto principal

Sugerencia desde mi punto de vista: te recomiendo que empieces con la tarea de creación de rutas API de tu proyecto principal, después las correcciones y finalmente las pruebas de integración porque esta secuencia optimiza tu tiempo. ¿Estás de acuerdo?"
`.trim();
    } else {
      // Prompt normal (solo tareas con tiempo) - CON PROYECTO PRINCIPAL
      prompt = `
Eres un asistente que analiza actividades del día con tiempo asignado.
Usuario: ${user.firstName} (${email})
Proyecto principal asignado: "${proyectoPrincipal}"

TAREAS CON TIEMPO ASIGNADO para tu proyecto "${proyectoPrincipal}":
Total: ${totalTareasConTiempo} tareas | Tiempo total: ${horasTotales}h ${minutosTotales}m
Tareas alta prioridad: ${tareasAltaPrioridad}

${Object.values(revisionesPorActividad).flatMap(act =>
        act.pendientesConTiempo.map(r =>
          `• ${r.nombre} - ${r.duracionMin}min (${r.prioridad}, ${r.diasPendiente}d)`
        )
      ).join('\n')}

PREGUNTA: "${question}"

INSTRUCCIONES ESTRICTAS DE RESPUESTA:
1. COMIENZA mencionando el proyecto principal: "Para tu proyecto '${proyectoPrincipal}'"
2. Enfócate SOLO en las tareas con tiempo asignado de este proyecto
3. Da prioridad principal basada en el proyecto
4. Recomendación breve relacionada con el proyecto
5. Pregunta final corta relacionada con el proyecto
6. MÁXIMO 4 renglones
7. SIN emojis
8. SIN formato especial

EJEMPLO DE RESPUESTA:
"Para tu proyecto '${proyectoPrincipal}', prioriza la creación de rutas API (80min, ALTA). Tienes 2h55m disponibles para este proyecto. ¿Por cuál tarea del proyecto quieres empezar?"
`.trim();
    }

    // 8️⃣ Obtener respuesta de IA
    const aiResult = await smartAICall(prompt);

    // ✅ Guardar respuesta del bot en historial
    await guardarMensajeHistorial(odooUserId, sessionId, "bot", aiResult.text);

    // 9️⃣ Preparar respuesta según el tipo
    let respuestaData = {
      actividades: actividadesFiltradas.map(a => ({
        id: a.id,
        titulo: a.titulo,
        horario: `${a.horaInicio} - ${a.horaFin}`,
        status: a.status,
        proyecto: a.tituloProyecto || "Sin proyecto",
        esPrincipal: a.horaInicio === '09:30' && a.horaFin === '16:30'
      })),
      revisionesPorActividad: {}
    };

    if (question.includes("otros horarios") || showAll) {
      respuestaData.revisionesPorActividad = Object.values(revisionesPorActividad)
        .filter(item => item.pendientesConTiempo.length > 0 || item.pendientesSinTiempo.length > 0)
        .map(item => ({
          actividadId: item.actividad.id,
          actividadTitulo: item.actividad.titulo,
          tareasConTiempo: item.pendientesConTiempo,
          tareasSinTiempo: item.pendientesSinTiempo,
          totalTareas: item.pendientesConTiempo.length + item.pendientesSinTiempo.length,
          tareasAltaPrioridad: item.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length,
          tiempoTotal: item.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0)
        }));
    } else {
      respuestaData.revisionesPorActividad = Object.values(revisionesPorActividad)
        .filter(item => item.pendientesConTiempo.length > 0)
        .map(item => ({
          actividadId: item.actividad.id,
          actividadTitulo: item.actividad.titulo,
          pendientesPlanificados: item.pendientesConTiempo.length,
          pendientesAlta: item.pendientesConTiempo.filter(p => p.prioridad === "ALTA").length,
          tiempoTotal: item.pendientesConTiempo.reduce((sum, p) => sum + (p.duracionMin || 0), 0),
          pendientes: item.pendientesConTiempo
        }));
    }

    // 🔟 Respuesta completa
    return res.json({
      success: true,
      answer: aiResult.text,
      provider: aiResult.provider,
      sessionId: sessionId,
      proyectoPrincipal: proyectoPrincipal,
      metrics: {
        totalActividades: actividadesFiltradas.length,
        tareasConTiempo: totalTareasConTiempo,
        tareasSinTiempo: totalTareasSinTiempo,
        tareasAltaPrioridad: tareasAltaPrioridad,
        tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`
      },
      data: respuestaData,
      separadasPorTiempo: true,
      sugerencias: question.includes("otros horarios") || showAll ? [
        `¿Te gustaría estimar tiempo para las ${totalTareasSinTiempo} tareas sin tiempo de '${proyectoPrincipal}'?`,
        `¿Quieres que te ayude a priorizar las tareas de '${proyectoPrincipal}'?`,
        "¿Necesitas ayuda para organizar tu día completo?"
      ] : [
        `¿Quieres profundizar en alguna tarea de '${proyectoPrincipal}'?`,
        `¿Necesitas ayuda para organizar las tareas de '${proyectoPrincipal}' por tiempo?`,
        "¿Quieres ver todas tus actividades del día?"
      ]
    });

  } catch (error) {
    if (error.message === "AI_PROVIDER_FAILED") {
      return res.status(503).json({
        success: false,
        message: "El asistente está muy ocupado. Intenta de nuevo en un minuto."
      });
    }

    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "El asistente está temporalmente saturado."
      });
    }

    console.error("Error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

// ✅ MEJORADA: Obtener actividades con más datos para sugerencias
async function obtenerActividadesYRevisiones(email) {
  try {
    const actividadesResponse = await axios.get(`${urlApi}/actividades/assignee/${email}/del-dia`);
    const actividadesRaw = actividadesResponse.data.data || [];

    // Obtener métricas básicas
    let totalTareas = 0;
    let tareasConTiempo = 0;
    let tareasSinTiempo = 0;
    let tareasAltaPrioridad = 0;
    let proyectoPrincipal = "Sin proyecto específico";

    // Buscar proyecto principal
    const actividadPrincipal = actividadesRaw.find(a => a.horaInicio === '09:30' && a.horaFin === '16:30');
    if (actividadPrincipal && actividadPrincipal.tituloProyecto) {
      proyectoPrincipal = actividadPrincipal.tituloProyecto;
    }

    return {
      actividades: actividadesRaw,
      revisionesPorActividad: {},
      metrics: {
        totalTareas,
        tareasConTiempo,
        tareasSinTiempo,
        tareasAltaPrioridad,
        proyectoPrincipal
      },
      proyectoPrincipal: proyectoPrincipal
    };
  } catch (error) {
    console.error("Error obteniendo actividades:", error);
    return {
      actividades: [],
      revisionesPorActividad: {},
      metrics: {
        totalTareas: 0,
        tareasConTiempo: 0,
        tareasSinTiempo: 0,
        tareasAltaPrioridad: 0,
        proyectoPrincipal: "Sin proyecto"
      },
      proyectoPrincipal: "Sin proyecto"
    };
  }
}

export async function seleccionarSugerencia(req, res) {
  try {
    const { email, sessionId, suggestionIndex, suggestionText } = sanitizeObject(req.body);

    if (!email || !sessionId || (suggestionIndex === undefined && !suggestionText)) {
      return res.status(400).json({
        success: false,
        message: "Email, sessionId y suggestionIndex o suggestionText son requeridos"
      });
    }

    // Verificar que la sesión existe
    if (!conversaciones.has(sessionId)) {
      return res.status(404).json({
        success: false,
        message: "Sesión no encontrada"
      });
    }

    const contexto = conversaciones.get(sessionId);

    // Verificar que el email coincide
    if (contexto.email !== email) {
      return res.status(403).json({
        success: false,
        message: "Email no coincide con la sesión"
      });
    }

    let sugerenciaSeleccionada = suggestionText;

    // Si se proporcionó índice, obtener el texto de la sugerencia
    if (suggestionIndex !== undefined && contexto.ultimasSugerencias) {
      const index = parseInt(suggestionIndex);
      if (index >= 0 && index < contexto.ultimasSugerencias.length) {
        sugerenciaSeleccionada = contexto.ultimasSugerencias[index];
      }
    }

    if (!sugerenciaSeleccionada) {
      return res.status(400).json({
        success: false,
        message: "Sugerencia no encontrada"
      });
    }

    // Crear una nueva "conversación" usando la sugerencia como mensaje
    const nuevoReq = {
      body: {
        email: email,
        message: sugerenciaSeleccionada,
        sessionId: sessionId,
        selectedSuggestion: suggestionIndex
      }
    };

    // Llamar a chatInteractivo con la sugerencia seleccionada
    return chatInteractivo(nuevoReq, res);

  } catch (error) {
    console.error("Error en seleccionarSugerencia:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

// ✅ NUEVA FUNCIÓN: Determinar tipo de sugerencia para mejor UI
function determinarTipoSugerencia(sugerencia) {
  const sugerenciaLower = sugerencia.toLowerCase();

  if (sugerenciaLower.includes('profundizar') || sugerenciaLower.includes('detalle')) {
    return 'DETAIL';
  } else if (sugerenciaLower.includes('organizar') || sugerenciaLower.includes('planificar')) {
    return 'ORGANIZE';
  } else if (sugerenciaLower.includes('priorizar') || sugerenciaLower.includes('recomendar')) {
    return 'PRIORITIZE';
  } else if (sugerenciaLower.includes('ver todas') || sugerenciaLower.includes('mostrar')) {
    return 'SHOW_ALL';
  } else if (sugerenciaLower.includes('tiempo') || sugerenciaLower.includes('estim')) {
    return 'TIME_MANAGEMENT';
  } else if (sugerenciaLower.includes('ayuda') || sugerenciaLower.includes('asistencia')) {
    return 'HELP';
  } else {
    return 'GENERAL';
  }
}


// ✅ MEJORADA: Generar sugerencias con más contexto
function generarSugerencias(estado, contexto = null) {
  const sugerenciasBase = {
    inicio: [
      "Pregúntame sobre tus actividades de hoy",
      "¿Qué necesitas revisar primero?",
      "¿Quieres que te ayude a priorizar tareas?"
    ],
    tiene_datos: [
      "¿Quieres profundizar en algún pendiente específico?",
      "¿Necesitas recomendaciones técnicas?",
      "¿Te ayudo a planificar el tiempo de cada tarea?"
    ],
    esperando_respuesta: [
      "Responde a mi pregunta anterior",
      "¿Necesitas más detalles sobre algo?",
      "¿Quieres cambiar de tema?"
    ],
    dando_recomendaciones: [
      "¿Te sirvió la recomendación?",
      "¿Quieres otra perspectiva?",
      "¿Necesitas ayuda para implementarlo?"
    ],
    revisando_tareas: [
      "¿Quieres ver los detalles de esta tarea?",
      "¿Necesitas desglosar el tiempo por subtareas?",
      "¿Quieres saber las dependencias de esta tarea?"
    ]
  };

  let sugerencias = sugerenciasBase[estado] || ["¿En qué más puedo ayudarte?"];

  // ✅ MEJORADO: Personalizar sugerencias según datos disponibles
  if (contexto && contexto.datosActividades && contexto.datosActividades.actividades) {
    const actividades = contexto.datosActividades.actividades;

    // Si hay muchas tareas sin tiempo, sugerir estimarlas
    const tieneTareasSinTiempo = contexto.datosActividades.metrics &&
      contexto.datosActividades.metrics.tareasSinTiempo > 0;

    if (tieneTareasSinTiempo) {
      sugerencias.push(`¿Quieres estimar tiempo para las ${contexto.datosActividades.metrics.tareasSinTiempo} tareas sin tiempo?`);
    }

    // Si hay tareas de alta prioridad
    const tieneAltaPrioridad = contexto.datosActividades.metrics &&
      contexto.datosActividades.metrics.tareasAltaPrioridad > 0;

    if (tieneAltaPrioridad) {
      sugerencias.push(`¿Necesitas ayuda con las ${contexto.datosActividades.metrics.tareasAltaPrioridad} tareas de alta prioridad?`);
    }

    // Si hay proyecto principal específico
    if (contexto.datosActividades.proyectoPrincipal) {
      const proyecto = contexto.datosActividades.proyectoPrincipal;
      if (proyecto.length > 50) {
        sugerencias.push(`¿Quieres enfocarte solo en el proyecto principal?`);
      } else {
        sugerencias.push(`¿Quieres enfocarte solo en '${proyecto.substring(0, 40)}...'?`);
      }
    }
  }

  // Limitar a máximo 5 sugerencias
  return sugerencias.slice(0, 5);
}

function determinarNuevoEstado(respuestaIA, contexto) {
  const respuestaLower = respuestaIA.toLowerCase();

  if (respuestaLower.includes('?') || respuestaLower.includes('¿')) {
    return 'esperando_respuesta';
  }

  if (respuestaLower.includes('recomiendo') || respuestaLower.includes('sugiero') ||
    respuestaLower.includes('te aconsejo') || respuestaLower.includes('prioriza')) {
    return 'dando_recomendaciones';
  }

  if (respuestaLower.includes('explic') || respuestaLower.includes('detall') ||
    respuestaLower.includes('información')) {
    return 'explicando_detalles';
  }

  if (contexto.datosActividades && contexto.datosActividades.actividades.length > 0) {
    return 'revisando_actividades';
  }

  return 'conversando';
}



function construirPromptContexto(contexto, mensajeActual) {
  // Mantener solo las últimas 6 interacciones para no saturar el prompt
  const historialRelevante = contexto.historial.slice(-6);

  let prompt = "Eres un asistente especializado en gestión de proyectos y productividad.\n\n";

  prompt += "CONTEXTO DE LA CONVERSACIÓN:\n";

  // Incluir información de actividades si está disponible
  if (contexto.datosActividades) {
    prompt += `- Proyecto principal: ${contexto.datosActividades.proyectoPrincipal}\n`;
    prompt += `- Total tareas: ${contexto.datosActividades.metrics.tareasConTiempo + contexto.datosActividades.metrics.tareasSinTiempo}\n`;
    prompt += `- Tiempo estimado: ${contexto.datosActividades.metrics.tiempoEstimadoTotal}\n`;
  }

  prompt += `- Estado actual: ${contexto.estado}\n\n`;

  prompt += "HISTORIAL RECIENTE:\n";
  historialRelevante.forEach((msg, index) => {
    const rol = msg.role === 'user' ? 'Usuario' : 'Asistente';
    const tipo = msg.tipo ? ` [${msg.tipo}]` : '';
    prompt += `${rol}${tipo}: ${msg.content}\n`;
  });

  prompt += `\nNUEVO MENSAJE DEL USUARIO: "${mensajeActual}"\n\n`;

  prompt += "INSTRUCCIONES PARA TU RESPUESTA:\n";
  prompt += "1. Mantén el contexto de la conversación anterior\n";
  prompt += "2. Sé útil, conciso y profesional\n";
  prompt += "3. Si es relevante, menciona el proyecto principal o las tareas\n";
  prompt += "4. Haz preguntas de seguimiento cuando sea apropiado\n";
  prompt += "5. NO uses emojis ni formato especial\n";
  prompt += "6. Mantén un tono amigable pero profesional\n";

  return prompt;
}




function limpiarConversacionesAntiguas() {
  const ahora = Date.now();
  const UNA_HORA = 60 * 60 * 1000;

  for (const [sessionId, contexto] of conversaciones.entries()) {
    if (ahora - contexto.timestamp > UNA_HORA) {
      conversaciones.delete(sessionId);
    }
  }
}

async function necesitaActualizarDatos(contexto, mensaje) {
  const palabrasActualizar = ['actualizar', 'nuevo', 'ahora', 'hoy', 'revisar', 'consultar'];
  const tienePalabraActualizar = palabrasActualizar.some(palabra =>
    mensaje.toLowerCase().includes(palabra)
  );

  if (!contexto.datosActividades || tienePalabraActualizar) {
    return true;
  }

  if (contexto.ultimaConsulta) {
    const ultima = new Date(contexto.ultimaConsulta);
    const ahora = new Date();
    const minutosDif = (ahora - ultima) / (1000 * 60);
    return minutosDif > 5;
  }

  return false;
}

// Funciones originales (mantener compatibilidad)
export async function devuelveActividades(req, res) {
  try {
    const { email } = sanitizeObject(req.body);

    // Obtener el ID del usuario desde el token (viene del middleware de auth)
    const sessionUserId = req.user?.id || req.user?._id;

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Generar sessionId para esta consulta
    const sessionId = `act_${sessionUserId}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');

    // ✅ Guardar consulta del usuario en historial
    await guardarMensajeHistorial(
      sessionUserId,
      sessionId,
      "usuario",
      `Consulta de actividades del día para ${email}`
    );

    const response = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = response.data.data;

    if (!Array.isArray(actividadesRaw)) {
      // ✅ Guardar respuesta del bot en historial
      await guardarMensajeHistorial(
        sessionUserId,
        sessionId,
        "bot",
        "No se encontraron actividades (respuesta inválida)"
      );
      return res.json([]);
    }

    // 1. Filtrar SOLO la actividad en horario 09:30-16:30
    const actividadSeleccionada = actividadesRaw.find((a) => {
      const inicio = horaAMinutos(a.horaInicio?.trim());
      const fin = horaAMinutos(a.horaFin?.trim());

      return inicio === horaAMinutos('09:30') && fin === horaAMinutos('16:30');
    });

    // 2. Si no hay actividad en ese horario, retornar array vacío
    if (!actividadSeleccionada) {
      // ✅ Guardar respuesta del bot en historial
      await guardarMensajeHistorial(
        sessionUserId,
        sessionId,
        "bot",
        "No hay actividades en horario 09:30-16:30"
      );
      return res.json([]);
    }

    // 3. Extraer duracionMin de cada pendiente
    const duracionesMin = actividadSeleccionada.pendientes && Array.isArray(actividadSeleccionada.pendientes)
      ? actividadSeleccionada.pendientes.map(p => p.duracionMin || 0)
      : [];

    // 4. Crear objeto con la estructura requerida
    const resultado = {
      t: actividadSeleccionada.titulo ? actividadSeleccionada.titulo.slice(0, 60) : "Sin título",
      h: `${actividadSeleccionada.horaInicio}-${actividadSeleccionada.horaFin}`,
      p: actividadSeleccionada.pendientes ? actividadSeleccionada.pendientes.length : 0,
      duraciones: duracionesMin
    };

    // 5. Filtrar según la regla (debe tener valor en "h")
    const actividadesFiltradas = resultado.h != null && resultado.h !== ""
      ? [resultado]
      : [];

    // ✅ Guardar respuesta del bot en historial
    await guardarMensajeHistorial(
      sessionUserId,
      sessionId,
      "bot",
      `Actividad encontrada: "${resultado.t}" con ${resultado.p} pendientes`
    );

    return res.json(actividadesFiltradas);

  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

export async function devuelveActReviciones(req, res) {
  try {
    const { email, idsAct, sessionId: reqSessionId } = sanitizeObject(req.body);

    if (!email || !Array.isArray(idsAct)) {
      return res.status(400).json({
        success: false,
        message: "Parámetros inválidos"
      });
    }

    // Obtener usuario para historial
    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    const odooUserId = user?.id || user?._id || email;
    const sessionId = reqSessionId || `rev_${email}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');

    // ✅ Guardar consulta del usuario en historial
    await guardarMensajeHistorial(
      odooUserId,
      sessionId,
      "usuario",
      `Consulta de revisiones para ${idsAct.length} actividades`
    );

    const today = new Date();
    const formattedToday = today.toISOString().split('T')[0];

    const response = await axios.get(
      `${urlApi}/reportes/revisiones-por-fecha?date=${formattedToday}&colaborador=${email}`
    );

    if (!response.data?.success) {
      return res.status(500).json({
        success: false,
        message: "Error al obtener revisiones"
      });
    }

    const revisiones = response.data.data;
    const actividadesRevi = new Map();

    revisiones.colaboradores.forEach(colaborador => {
      (colaborador.items?.actividades ?? []).forEach(actividad => {
        if (idsAct.length && !idsAct.includes(actividad.id)) return;

        const pendientesFiltrados = (actividad.pendientes ?? [])
          .filter(p => p.assignees?.some(a => a.name === email))
          .map(p => ({
            id: p.id,
            nombre: p.nombre,
            terminada: p.terminada,
            confirmada: p.confirmada,
            duracionMin: p.duracionMin,
            fechaCreacion: p.fechaCreacion,
            fechaFinTerminada: p.fechaFinTerminada,
            prioridad: p.duracionMin > 60 ? "ALTA" :
              p.duracionMin > 30 ? "MEDIA" :
                p.duracionMin > 0 ? "BAJA" : "SIN TIEMPO"
          }));

        if (!pendientesFiltrados.length) return;

        if (!actividadesRevi.has(actividad.id)) {
          actividadesRevi.set(actividad.id, {
            actividades: {
              id: actividad.id,
              titulo: actividad.titulo
            },
            pendientes: pendientesFiltrados,
            assignees: pendientesFiltrados[0]?.assignees ?? [
              { name: email }
            ]
          });
        }
      });
    });

    const resultado = Array.from(actividadesRevi.values());
    const totalPendientes = resultado.reduce((sum, act) => sum + act.pendientes.length, 0);

    // ✅ Guardar respuesta del bot en historial
    await guardarMensajeHistorial(
      odooUserId,
      sessionId,
      "bot",
      `Se encontraron ${resultado.length} actividades con ${totalPendientes} pendientes totales.`
    );

    return res.status(200).json({
      success: true,
      sessionId: sessionId,
      data: resultado
    });

  } catch (error) {
    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "Intenta nuevamente en unos minutos."
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

export async function guardarPendientes(req, res) {
  try {
    // Acepta tanto userId como odooUserId para compatibilidad
    const { userId, odooUserId, activityId, pendientes, sessionId: reqSessionId } = req.body;

    // Usar odooUserId si existe, sino usar userId
    const finalUserId = odooUserId || userId;

    if (!finalUserId || !activityId || !Array.isArray(pendientes)) {
      console.log("error datos faltentes o los pendientes no son un array")
      return res.status(400).json({
        error: "Faltan datos requeridos"
      });
    }

    const sessionId = reqSessionId || `pend_${finalUserId}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');

    // ✅ Guardar acción del usuario en historial
    await guardarMensajeHistorial(
      finalUserId,
      sessionId,
      "usuario",
      `Guardando ${pendientes.length} pendientes para la actividad ${activityId}`
    );

    const registro = await ActividadPendientes.create({
      userId: finalUserId,  // Guardar con el campo original del modelo
      activityId,
      pendientes
    });

    // ✅ Guardar confirmación del bot en historial
    await guardarMensajeHistorial(
      finalUserId,
      sessionId,
      "bot",
      `Se guardaron exitosamente ${pendientes.length} pendientes. ID: ${registro._id}`
    );

    res.status(201).json({
      ...registro.toObject(),
      sessionId: sessionId
    });
  } catch (error) {
    console.error("Error en guardarPendientes:", error);
    res.status(500).json({ error: error.message });
  }
}

// ✅ NUEVAS FUNCIONES: Obtener historial desde MongoDB

/**
 * Obtiene el historial de una sesión específica
 */
export async function obtenerHistorialSesion(req, res) {
  try {
    const { odooUserId, sessionId } = sanitizeObject(req.query);

    if (!odooUserId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "odooUserId y sessionId son requeridos"
      });
    }

    const historial = await HistorialBot.findOne({ odooUserId, sessionId });

    if (!historial) {
      return res.status(404).json({
        success: false,
        message: "No se encontró historial para esta sesión"
      });
    }

    return res.json({
      success: true,
      data: historial
    });

  } catch (error) {
    console.error("Error obteniendo historial:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

/**
 * Obtiene todos los historiales de un usuario con paginación
 */
export async function obtenerHistorialesUsuario(req, res) {
  try {
    const { odooUserId, limit = 10, skip = 0 } = sanitizeObject(req.query);

    if (!odooUserId) {
      return res.status(400).json({
        success: false,
        message: "odooUserId es requerido"
      });
    }

    const historiales = await HistorialBot.find({ odooUserId })
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await HistorialBot.countDocuments({ odooUserId });

    return res.json({
      success: true,
      data: historiales,
      pagination: {
        total,
        limit: parseInt(limit),
        skip: parseInt(skip),
        hasMore: (parseInt(skip) + historiales.length) < total
      }
    });

  } catch (error) {
    console.error("Error obteniendo historiales:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

/**
 * Elimina el historial de una sesión específica
 */
export async function eliminarHistorialSesion(req, res) {
  try {
    const { odooUserId, sessionId } = sanitizeObject(req.body);

    if (!odooUserId || !sessionId) {
      return res.status(400).json({
        success: false,
        message: "odooUserId y sessionId son requeridos"
      });
    }

    const resultado = await HistorialBot.deleteOne({ odooUserId, sessionId });

    if (resultado.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No se encontró historial para eliminar"
      });
    }

    return res.json({
      success: true,
      message: "Historial eliminado correctamente"
    });

  } catch (error) {
    console.error("Error eliminando historial:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}