import axios from 'axios';
import { getAllUsers } from './users.controller.js';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { smartAICall } from '../libs/aiService.js';

const urlApi = 'https://wlserver-production.up.railway.app/api';

// Almacenamiento en memoria para conversaciones
const conversaciones = new Map();

// Función auxiliar
function horaAMinutos(hora) {
  if (!hora) return null;
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Sistema de conversación interactiva con historial
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

    // 1. Obtener o crear contexto de conversación
    if (!conversaciones.has(sessionId)) {
      conversaciones.set(sessionId, {
        userId: email,
        historial: [],
        datosActividades: null,
        ultimaConsulta: null,
        timestamp: Date.now(),
        estado: 'inicio'
      });
    }

    const contexto = conversaciones.get(sessionId);

    // Limpiar conversaciones antiguas (más de 1 hora)
    limpiarConversacionesAntiguas();

    // 2. Agregar mensaje del usuario al historial
    contexto.historial.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString()
    });

    // 3. Verificar si necesitamos obtener datos frescos
    const necesitaDatosFrescos = await necesitaActualizarDatos(contexto, message);

    if (necesitaDatosFrescos) {
      // Obtener datos actualizados de actividades y revisiones
      const actividadesData = await obtenerActividadesYRevisiones(email);
      contexto.datosActividades = actividadesData;
      contexto.ultimaConsulta = new Date().toISOString();
      contexto.estado = 'tiene_datos';
    }

    // 4. Preparar contexto para IA
    const promptContexto = construirPromptContexto(contexto, message);

    // 5. Obtener respuesta de IA
    const aiResult = await smartAICall(promptContexto);

    // 6. Guardar respuesta en historial
    contexto.historial.push({
      role: 'assistant',
      content: aiResult.text,
      timestamp: new Date().toISOString()
    });

    // 7. Actualizar estado según la respuesta
    contexto.estado = determinarNuevoEstado(aiResult.text);

    // 8. Preparar respuesta
    const respuesta = {
      success: true,
      answer: aiResult.text,
      provider: aiResult.provider,
      sessionId: sessionId,
      contexto: {
        tieneDatos: contexto.datosActividades !== null,
        estado: contexto.estado,
        historialCount: contexto.historial.length
      },
      sugerencias: generarSugerencias(contexto.estado)
    };

    // 9. Incluir datos si están disponibles
    if (contexto.datosActividades) {
      respuesta.data = {
        actividades: contexto.datosActividades.actividades,
        revisiones: contexto.datosActividades.revisionesPorActividad,
        metrics: contexto.datosActividades.metrics
      };
    }

    return res.json(respuesta);

  } catch (error) {
    console.error("Error en chatInteractivo:", error);

    if (error.message === "AI_PROVIDER_FAILED") {
      return res.status(503).json({
        success: false,
        message: "El asistente esta muy ocupado en este momento. Danos un minuto y vuelve a intentarlo"
      });
    }

    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "El asistente esta temporalmente saturado. Intenta nuevamente en unos minutos"
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

export async function getActividadesConRevisiones(req, res) {
  try {
    const { email, question = "Que actividades y revisiones tengo hoy? Que me recomiendas priorizar?", showAll = false } = sanitizeObject(req.body);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "El email es requerido"
      });
    }

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // 1️⃣ Obtener actividades del dia para el usuario
    const actividadesResponse = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = actividadesResponse.data.data;
    console.log("Actividades del dia:", actividadesRaw);

    if (!Array.isArray(actividadesRaw) || actividadesRaw.length === 0) {
      return res.json({
        success: true,
        answer: "No tienes actividades registradas para hoy",
        actividades: [],
        revisionesPorActividad: {}
      });
    }

    // 🔍 OBTENER PROYECTO PRINCIPAL (actividad 09:30-16:30) - DINAMICO
    const actividadPrincipal = actividadesRaw.find(a =>
      a.horaInicio === '09:30' && a.horaFin === '16:30'
    );

    // Proyecto principal DINAMICO - usar datos reales de la API
    const proyectoPrincipal = actividadPrincipal?.tituloProyecto || 
                             actividadPrincipal?.titulo || 
                             "Actividades del dia";

    // FILTRAR según el parámetro showAll
    let actividadesFiltradas = [];
    let mensajeHorario = "";
    let mostrarSoloConTiempo = true;

    if (question.includes("otros horarios") || showAll) {
      // MOSTRAR TODAS las actividades del dia (con y sin tiempo)
      actividadesFiltradas = actividadesRaw;
      mensajeHorario = "Mostrando todas las actividades del dia";
      mostrarSoloConTiempo = false;
      console.log("Mostrando TODAS las actividades:", actividadesFiltradas);
    } else {
      // Filtrar SOLO la actividad con horario 09:30-16:30 (solo con tiempo)
      actividadesFiltradas = actividadesRaw.filter((a) => {
        return a.horaInicio === '09:30' && a.horaFin === '16:30';
      });
      mensajeHorario = "Actividades en horario 09:30-16:30";
      console.log("Actividades filtradas (09:30-16:30):", actividadesFiltradas);

      if (actividadesFiltradas.length === 0) {
        return res.json({
          success: true,
          answer: "No tienes actividades programadas en el horario de 09:30 a 16:30",
          actividades: actividadesRaw.map(a => ({
            id: a.id,
            titulo: a.titulo,
            horario: `${a.horaInicio} - ${a.horaFin}`,
            status: a.status,
            proyecto: a.tituloProyecto || "Sin proyecto"
          })),
          revisionesPorActividad: {},
          sugerencias: [
            "Quieres ver todas tus actividades del dia?",
            "Necesitas ayuda con actividades en otros horarios?",
            "Quieres que te ayude a planificar estas actividades?"
          ]
        });
      }
    }

    // 2️⃣ Extraer IDs de todas las actividades filtradas
    const actividadIds = actividadesFiltradas.map(a => a.id);

    // 3️⃣ Obtener fecha actual para las revisiones
    const today = new Date();
    const formattedToday = today.toISOString().split('T')[0];

    // 4️⃣ Obtener TODAS las revisiones del dia
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
        pendientesConTiempo: [], // ✅ SEPARADO: tareas CON tiempo
        pendientesSinTiempo: []  // ✅ SEPARADO: tareas SIN tiempo
      };

      // Inicializar arrays separados
      tareasConTiempo[actividad.id] = [];
      tareasSinTiempo[actividad.id] = [];
    });

    // Procesar revisiones - SEPARAR por tiempo
    if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
      todasRevisiones.colaboradores.forEach(colaborador => {
        (colaborador.items?.actividades ?? []).forEach(actividad => {
          if (actividadIds.includes(actividad.id) && actividad.pendientes) {
            // Procesar cada pendiente
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
                // Tarea CON tiempo
                pendienteInfo.prioridad = p.duracionMin > 60 ? "ALTA" :
                                         p.duracionMin > 30 ? "MEDIA" : "BAJA";
                tareasConTiempo[actividad.id].push(pendienteInfo);
                revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);
              } else {
                // Tarea SIN tiempo
                pendienteInfo.prioridad = "SIN TIEMPO";
                tareasSinTiempo[actividad.id].push(pendienteInfo);
                revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
              }
            });
          }
        });
      });
    }

    // 6️⃣ Calcular metricas DINAMICAS
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0;
    let tareasAltaPrioridad = 0;
    let tiempoTotalEstimado = 0;

    Object.keys(revisionesPorActividad).forEach(actividadId => {
      const actividad = revisionesPorActividad[actividadId];
      totalTareasConTiempo += actividad.pendientesConTiempo.length;
      totalTareasSinTiempo += actividad.pendientesSinTiempo.length;
      
      // Contar tareas de alta prioridad (solo las con tiempo)
      tareasAltaPrioridad += actividad.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length;
      
      // Sumar tiempo total (solo las con tiempo)
      tiempoTotalEstimado += actividad.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;
    const totalTareas = totalTareasConTiempo + totalTareasSinTiempo;

    // 7️⃣ Construir prompt DINAMICO
    let prompt = "";

    if (question.includes("otros horarios") || showAll || !mostrarSoloConTiempo) {
      // Prompt para mostrar TODAS (con y sin tiempo)
      prompt = `
Analiza estas actividades para ${user.firstName} (${email})

PROYECTO PRINCIPAL: ${proyectoPrincipal}
ACTIVIDADES: ${actividadesFiltradas.length}
TAREAS TOTALES: ${totalTareas} (${totalTareasConTiempo} con tiempo, ${totalTareasSinTiempo} sin tiempo)
TIEMPO ESTIMADO: ${horasTotales}h ${minutosTotales}m

DETALLE POR ACTIVIDAD:
${actividadesFiltradas.map((actividad, idx) => {
  const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
  const conTiempo = revisiones.pendientesConTiempo;
  const sinTiempo = revisiones.pendientesSinTiempo;
  
  return `
${idx + 1}. ${actividad.horario} - ${actividad.titulo}
   Proyecto: ${actividad.tituloProyecto || "Sin proyecto"}
   Estado: ${actividad.status}
   Tareas: ${conTiempo.length + sinTiempo.length} (${conTiempo.length} con tiempo, ${sinTiempo.length} sin tiempo)`;
}).join('')}

${totalTareasConTiempo > 0 ? `
TAREAS CON TIEMPO ESTIMADO:
${Object.values(revisionesPorActividad).flatMap(act => 
  act.pendientesConTiempo.map(t => `• ${t.nombre} (${t.duracionMin}min, ${t.prioridad}, ${t.diasPendiente}d)`)
).join('\n')}` : ''}

${totalTareasSinTiempo > 0 ? `
TAREAS SIN TIEMPO ESTIMADO:
${Object.values(revisionesPorActividad).flatMap(act => 
  act.pendientesSinTiempo.map(t => `• ${t.nombre} (${t.diasPendiente}d pendiente)`)
).join('\n')}` : ''}

PREGUNTA: "${question}"

RESPONDE:
1. Menciona el proyecto principal
2. Resumen de tareas (con y sin tiempo)
3. Recomendaciones especificas
4. Pregunta sobre que trabajar primero

SIN emojis. Maximo 150 palabras.
`.trim();
    } else {
      // Prompt para mostrar solo CON TIEMPO (09:30-16:30)
      prompt = `
Analiza estas tareas para ${user.firstName} (${email})

PROYECTO: ${proyectoPrincipal}
TAREAS CON TIEMPO: ${totalTareasConTiempo}
TIEMPO TOTAL: ${horasTotales}h ${minutosTotales}m
TAREAS ALTA PRIORIDAD: ${tareasAltaPrioridad}

TAREAS PARA HOY:
${Object.values(revisionesPorActividad).flatMap(act => 
  act.pendientesConTiempo.map(t => `• ${t.nombre} (${t.duracionMin}min, ${t.prioridad}, ${t.diasPendiente}d)`)
).join('\n')}

PREGUNTA: "${question}"

RESPONDE:
1. Prioridad principal
2. Recomendacion breve
3. Pregunta final corta

SIN emojis. Maximo 4 lineas.
`.trim();
    }

    // 8️⃣ Obtener respuesta de IA
    const aiResult = await smartAICall(prompt);

    // 9️⃣ Preparar respuesta estructurada
    const respuestaData = {
      actividades: actividadesFiltradas.map(a => ({
        id: a.id,
        titulo: a.titulo,
        horario: `${a.horaInicio} - ${a.horaFin}`,
        status: a.status,
        proyecto: a.tituloProyecto || "Sin proyecto",
        esPrincipal: a.horaInicio === '09:30' && a.horaFin === '16:30'
      })),
      revisionesPorActividad: Object.values(revisionesPorActividad)
        .filter(item => item.pendientesConTiempo.length > 0 || item.pendientesSinTiempo.length > 0)
        .map(item => ({
          actividadId: item.actividad.id,
          actividadTitulo: item.actividad.titulo,
          tareasConTiempo: item.pendientesConTiempo,
          tareasSinTiempo: item.pendientesSinTiempo,
          totalTareas: item.pendientesConTiempo.length + item.pendientesSinTiempo.length,
          tareasAltaPrioridad: item.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length,
          tiempoTotal: item.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0)
        }))
    };

    // 🔟 Respuesta completa
    return res.json({
      success: true,
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
      data: respuestaData,
      separadasPorTiempo: true, // ✅ Indica que las tareas están separadas
      sugerencias: question.includes("otros horarios") || showAll ? [
        `Quieres estimar tiempo para las ${totalTareasSinTiempo} tareas sin tiempo?`,
        `Quieres priorizar las tareas de ${proyectoPrincipal}?`,
        "Necesitas ayuda para organizar tu dia completo?"
      ] : [
        `Quieres profundizar en alguna tarea de ${proyectoPrincipal}?`,
        `Necesitas ayuda para organizar las tareas por tiempo?`,
        "Quieres ver todas tus actividades del dia?"
      ]
    });

  } catch (error) {
    if (error.message === "AI_PROVIDER_FAILED") {
      return res.status(503).json({
        success: false,
        message: "El asistente esta muy ocupado. Intenta de nuevo en un minuto"
      });
    }

    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "El asistente esta temporalmente saturado"
      });
    }

    console.error("Error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

// Funciones auxiliares para el chat interactivo
async function obtenerActividadesYRevisiones(email) {
  try {
    const actividadesResponse = await axios.get(`${urlApi}/actividades/assignee/${email}/del-dia`);
    const actividadesRaw = actividadesResponse.data.data || [];
    
    return {
      actividades: actividadesRaw,
      revisionesPorActividad: {},
      metrics: {}
    };
  } catch (error) {
    console.error("Error obteniendo actividades:", error);
    return {
      actividades: [],
      revisionesPorActividad: {},
      metrics: {}
    };
  }
}

function construirPromptContexto(contexto, mensajeActual) {
  const historialReciente = contexto.historial.slice(-6);
  
  let prompt = "Historial de conversacion:\n";
  
  historialReciente.forEach(msg => {
    prompt += `${msg.role === 'user' ? 'Usuario' : 'Asistente'}: ${msg.content}\n`;
  });

  prompt += `\nNuevo mensaje: ${mensajeActual}\n`;
  prompt += `Estado: ${contexto.estado}\n`;
  prompt += `Datos disponibles: ${contexto.datosActividades ? 'Si' : 'No'}\n\n`;
  prompt += "Responde de manera natural, haz preguntas de seguimiento relevantes.";

  return prompt;
}

function determinarNuevoEstado(respuestaIA) {
  if (respuestaIA.includes('?')) return 'esperando_respuesta';
  if (respuestaIA.includes('recomiendo') || respuestaIA.includes('sugiero')) return 'dando_recomendaciones';
  return 'conversando';
}

function generarSugerencias(estado) {
  const sugerencias = {
    inicio: [
      "Preguntame sobre tus actividades de hoy",
      "Que necesitas revisar primero?",
      "Quieres que te ayude a priorizar tareas?"
    ],
    tiene_datos: [
      "Quieres profundizar en algun pendiente?",
      "Necesitas recomendaciones tecnicas?",
      "Te ayudo a planificar el tiempo?"
    ],
    esperando_respuesta: [
      "Responde a mi pregunta anterior",
      "Necesitas mas detalles?",
      "Quieres cambiar de tema?"
    ],
    dando_recomendaciones: [
      "Te sirvio la recomendacion?",
      "Quieres otra perspectiva?",
      "Necesitas ayuda para implementarlo?"
    ]
  };

  return sugerencias[estado] || ["En que mas puedo ayudarte?"];
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

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const response = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = response.data.data;

    if (!Array.isArray(actividadesRaw)) {
      return res.json([]);
    }

    // Filtrar SOLO la actividad en horario 09:30-16:30
    const actividadSeleccionada = actividadesRaw.find((a) => {
      const inicio = horaAMinutos(a.horaInicio?.trim());
      const fin = horaAMinutos(a.horaFin?.trim());

      return inicio === horaAMinutos('09:30') && fin === horaAMinutos('16:30');
    });

    if (!actividadSeleccionada) {
      return res.json([]);
    }

    // Extraer duracionMin
    const duracionesMin = actividadSeleccionada.pendientes && Array.isArray(actividadSeleccionada.pendientes)
      ? actividadSeleccionada.pendientes.map(p => p.duracionMin || 0)
      : [];

    const resultado = {
      t: actividadSeleccionada.titulo ? actividadSeleccionada.titulo.slice(0, 60) : "Sin titulo",
      h: `${actividadSeleccionada.horaInicio}-${actividadSeleccionada.horaFin}`,
      p: actividadSeleccionada.pendientes ? actividadSeleccionada.pendientes.length : 0,
      duraciones: duracionesMin
    };

    const actividadesFiltradas = resultado.h != null && resultado.h !== ""
      ? [resultado]
      : [];

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
    const { email, idsAct } = sanitizeObject(req.body);

    if (!email || !Array.isArray(idsAct)) {
      return res.status(400).json({
        success: false,
        message: "Parametros invalidos"
      });
    }

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

    return res.status(200).json({
      success: true,
      data: Array.from(actividadesRevi.values())
    });

  } catch (error) {
    if (isGeminiQuotaError(error)) {
      return res.status(429).json({
        success: false,
        reason: "QUOTA_EXCEEDED",
        message: "Intenta nuevamente en unos minutos"
      });
    }

    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}