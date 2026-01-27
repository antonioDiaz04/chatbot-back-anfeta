import axios from 'axios';
import { getAllUsers } from './users.controller.js';
import jwt from 'jsonwebtoken';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { smartAICall } from '../libs/aiService.js';
import { generarSessionIdDiario } from '../libs/generarSessionIdDiario.js';
import { horaAMinutos } from '../libs/horaAMinutos.js';
import ActividadesSchema from "../models/actividades.model.js";
import HistorialBot from "../models/historialBot.model.js";
import { TOKEN_SECRET } from '../config.js';

const urlApi = 'https://wlserver-production.up.railway.app/api';

export async function getActividadesConRevisiones(req, res) {
  try {
    const { email, question = "¿Qué actividades y revisiones tengo hoy? ¿Qué me recomiendas priorizar?", showAll = false } = sanitizeObject(req.body);

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

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id.toString();

    const sessionId = generarSessionIdDiario(odooUserId);


    // 1️ Obtener actividades del día para el usuario
    const actividadesResponse = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = actividadesResponse.data.data;

    if (!Array.isArray(actividadesRaw) || actividadesRaw.length === 0) {
      const respuestaSinActividades = "No tienes actividades registradas para hoy";

  

      return res.json({
        success: true,
        answer: respuestaSinActividades,
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {}
      });
    }

    // 2️ Obtener fecha actual para las revisiones
    const today = new Date();
    const formattedToday = today.toISOString().split('T')[0];

    // 3️ Obtener TODAS las revisiones del día
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

    // 4️ Filtrar actividades: 
    // - Excluir las que contienen "00ftf" en el título
    // - Excluir las que tienen status "00sec"
    let actividadesFiltradas = actividadesRaw.filter((actividad) => {
      // Excluir actividades con "00ftf" en el título
      const tiene00ftf = actividad.titulo.toLowerCase().includes('00ftf');
      // Excluir actividades con status "00sec"
      const es00sec = actividad.status === "00sec";

      return !tiene00ftf && !es00sec;
    });

    // 5️ Extraer IDs de todas las actividades filtradas
    const actividadIds = actividadesFiltradas.map(a => a.id);

    // 6️ Procesar revisiones y verificar qué actividades tienen tareas CON TIEMPO
    const revisionesPorActividad = {};
    const actividadesConRevisionesConTiempoIds = new Set(); // Para guardar IDs de actividades que SÍ tienen revisiones CON TIEMPO

    // Procesar revisiones
    if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
      todasRevisiones.colaboradores.forEach(colaborador => {
        (colaborador.items?.actividades ?? []).forEach(actividad => {
          // Solo procesar actividades que están en nuestro filtro
          if (actividadIds.includes(actividad.id) && actividad.pendientes) {
            // Inicializar estructura para esta actividad
            revisionesPorActividad[actividad.id] = {
              actividad: {
                id: actividad.id,
                titulo: actividad.titulo,
                horaInicio: actividadesRaw.find(a => a.id === actividad.id)?.horaInicio || "00:00",
                horaFin: actividadesRaw.find(a => a.id === actividad.id)?.horaFin || "00:00",
                status: actividadesRaw.find(a => a.id === actividad.id)?.status || "Sin status",
                proyecto: actividadesRaw.find(a => a.id === actividad.id)?.tituloProyecto || "Sin proyecto"
              },
              pendientesConTiempo: [],
              pendientesSinTiempo: []
            };

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

              // SEPARAR por tiempo - SOLO guardamos las con tiempo para análisis
              if (p.duracionMin && p.duracionMin > 0) {
                pendienteInfo.prioridad = p.duracionMin > 60 ? "ALTA" :
                  p.duracionMin > 30 ? "MEDIA" : "BAJA";
                revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);

                // Marcar que esta actividad tiene al menos una revisión CON TIEMPO
                actividadesConRevisionesConTiempoIds.add(actividad.id);
              } else {
                // Las tareas sin tiempo las guardamos pero no las usamos para filtrar
                pendienteInfo.prioridad = "SIN TIEMPO";
                revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
              }
            });
          }
        });
      });
    }

    // 7️ Filtrar actividades:
    // - Que tengan revisiones CON TIEMPO
    // - Que estén en horario laboral (09:00-17:30)
    const actividadesFinales = actividadesFiltradas.filter(actividad => {
      // Verificar si tiene revisiones CON TIEMPO
      const tieneRevisionesConTiempo = actividadesConRevisionesConTiempoIds.has(actividad.id);
      if (!tieneRevisionesConTiempo) return false;

      // Verificar si está en horario laboral (09:00-17:30)
      const horaInicio = parseInt(actividad.horaInicio.split(':')[0]);
      const estaEnHorarioLaboral = horaInicio >= 9 && horaInicio <= 17;

      return estaEnHorarioLaboral;
    });

    // Si no hay actividades que cumplan todos los criterios
    if (actividadesFinales.length === 0) {
      // Verificar qué criterios no se cumplen
      const actividadesConTiempo = actividadesFiltradas.filter(a =>
        actividadesConRevisionesConTiempoIds.has(a.id)
      );

      const actividadesHorarioLaboral = actividadesFiltradas.filter(a => {
        const horaInicio = parseInt(a.horaInicio.split(':')[0]);
        return horaInicio >= 9 && horaInicio <= 17;
      });

      let mensajeError = "";
      if (actividadesConTiempo.length === 0) {
        mensajeError = "No tienes actividades con tareas que tengan tiempo estimado para hoy.";
      } else if (actividadesHorarioLaboral.length === 0) {
        mensajeError = "No tienes actividades programadas en horario laboral (09:00-17:30).";
      } else {
        mensajeError = `Tienes ${actividadesConTiempo.length} actividades con tareas con tiempo, pero ninguna en horario laboral.`;
      }

      return res.json({
        success: true,
        answer: mensajeError,
        sessionId: sessionId,
        actividadesTotales: actividadesFiltradas.length,
        actividadesConTiempo: actividadesConTiempo.length,
        actividadesHorarioLaboral: actividadesHorarioLaboral.length,
        actividadesFinales: 0,
        // sugerencias: [
        //   actividadesConTiempo.length > 0 ? `¿Quieres ver las ${actividadesConTiempo.length} actividades con tareas con tiempo (fuera de horario laboral)?` : "¿Quieres ver todas tus actividades programadas?",
        //   "¿Necesitas ayuda para asignar tiempo a tus tareas pendientes?",
        //   "¿Te gustaría revisar actividades de otros días?"
        // ]
      });
    }

    // 8️ Calcular métricas SOLO de actividades finales (con tiempo y en horario laboral)
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0; // Solo para referencia, no se mostrarán
    let tareasAltaPrioridad = 0;
    let tiempoTotalEstimado = 0;

    actividadesFinales.forEach(actividad => {
      const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
      totalTareasConTiempo += revisiones.pendientesConTiempo.length;
      totalTareasSinTiempo += revisiones.pendientesSinTiempo.length; // Solo para métricas
      tareasAltaPrioridad += revisiones.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length;
      tiempoTotalEstimado += revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;

    // OBTENER PROYECTO PRINCIPAL (de las actividades finales)
    let proyectoPrincipal = "Sin proyecto específico";
    if (actividadesFinales.length > 0) {
      const actividadPrincipal = actividadesFinales[0]; // Tomar la primera
      if (actividadPrincipal.tituloProyecto && actividadPrincipal.tituloProyecto !== "Sin proyecto") {
        proyectoPrincipal = actividadPrincipal.tituloProyecto;
      } else if (actividadPrincipal.titulo) {
        // Intentar extraer del título
        const tituloLimpio = actividadPrincipal.titulo
          .replace('analizador de pendientes 00act', '')
          .replace('anfeta', '')
          .replace(/00\w+/g, '')
          .trim();
        proyectoPrincipal = tituloLimpio || actividadPrincipal.titulo.substring(0, 50) + "...";
      }
    }

    // 9️ Construir prompt enfocado SOLO en actividades con revisiones CON TIEMPO en horario laboral
    const prompt = `
Eres un asistente que analiza ÚNICAMENTE actividades que:
1. Tienen revisiones CON TIEMPO estimado
2. Están en horario laboral (09:00-17:30)
3. Se han filtrado actividades 00ftf y status 00sec

Usuario: ${user.firstName} (${email})

RESUMEN DE ACTIVIDADES CON REVISIONES CON TIEMPO (09:00-17:30):
• Total actividades: ${actividadesFinales.length}
• Total tareas con tiempo: ${totalTareasConTiempo}
• Tareas de alta prioridad: ${tareasAltaPrioridad}
• Tiempo estimado total: ${horasTotales}h ${minutosTotales}m

DETALLE DE ACTIVIDADES (SOLO TAREAS CON TIEMPO):
${actividadesFinales.map((actividad, index) => {
      const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
      const conTiempo = revisiones.pendientesConTiempo;

      let actividadTexto = `
${index + 1}. ${actividad.horaInicio} - ${actividad.horaFin} - ${actividad.titulo}
   • Proyecto: ${actividad.tituloProyecto || "Sin proyecto"}
   • Estado: ${actividad.status}
   • Tareas con tiempo: ${conTiempo.length}`;

      if (conTiempo.length > 0) {
        actividadTexto += `
   • TIEMPO TOTAL: ${revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0)}min`;
        conTiempo.forEach((tarea, i) => {
          actividadTexto += `
     ${i + 1}. ${tarea.nombre}
        - ${tarea.duracionMin} min | Prioridad: ${tarea.prioridad} | Dias pendiente: ${tarea.diasPendiente}d`;
        });
      }

      // NO mencionar tareas sin tiempo en el prompt
      if (revisiones.pendientesSinTiempo.length > 0) {
        // Solo para información interna, no se muestra al usuario
        actividadTexto += `\n   • [NOTA INTERNA: ${revisiones.pendientesSinTiempo.length} tareas sin tiempo - NO MOSTRAR AL USUARIO]`;
      }

      return actividadTexto;
    }).join('\n')}

PREGUNTA DEL USUARIO: "${question}"

INSTRUCCIONES ESTRICTAS DE RESPUESTA:
1. COMIENZA específicamente: "En tu horario laboral (09:00-17:30), tienes ${actividadesFinales.length} actividades con tareas que tienen tiempo estimado"
2. ENFÓCATE EXCLUSIVAMENTE en las tareas CON TIEMPO (${totalTareasConTiempo} tareas)
3. NO MENCIONES ni hagas referencia a tareas sin tiempo
4. Para CADA actividad, menciona:
   - Horario y nombre breve
   - Número de tareas con tiempo
   - Tiempo total estimado
5. Da RECOMENDACIONES ESPECÍFICAS basadas en:
   - Prioridad de tareas (ALTA primero)
   - Tiempo total de cada actividad
   - Horario disponible
6. Sugiere un ORDEN DE EJECUCIÓN claro para el día laboral
7. MÁXIMO 6-8 renglones
8. SIN emojis
9. EVITA mencionar "tareas sin tiempo", "sin estimación", etc.

EJEMPLO DE RESPUESTA:
"En tu horario laboral (09:00-17:30), tienes 2 actividades con tareas que tienen tiempo estimado. En 'ANFETA WL PRUEBAS RAPIDAS' (14:30-17:30) tienes 1 tarea de alta prioridad de 180min. En 'RESPALDO NOTION MIGRACION' (14:30-17:30) tienes la misma tarea de 180min. Te sugiero enfocarte en esta tarea de alta prioridad durante la tarde, ya que suma 6 horas entre ambas. ¿Quieres comenzar con esta tarea o prefieres dividirla?"
`.trim();

    //  Obtener respuesta de IA
    const aiResult = await smartAICall(prompt);

  

    // 1️.1 Preparar respuesta estructurada SOLO con actividades finales
    const respuestaData = {
      actividades: actividadesFinales.map(a => ({
        id: a.id,
        titulo: a.titulo,
        horario: `${a.horaInicio} - ${a.horaFin}`,
        status: a.status,
        proyecto: a.tituloProyecto || "Sin proyecto",
        esHorarioLaboral: true, // Todas están en horario laboral por el filtro
        tieneRevisionesConTiempo: true
      })),
      revisionesPorActividad: actividadesFinales
        .map(actividad => {
          const revisiones = revisionesPorActividad[actividad.id];
          if (!revisiones || revisiones.pendientesConTiempo.length === 0) return null;

          return {
            actividadId: actividad.id,
            actividadTitulo: actividad.titulo,
            actividadHorario: `${actividad.horaInicio} - ${actividad.horaFin}`,
            tareasConTiempo: revisiones.pendientesConTiempo, // SOLO tareas con tiempo
            totalTareasConTiempo: revisiones.pendientesConTiempo.length,
            tareasAltaPrioridad: revisiones.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length,
            tiempoTotal: revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0),
            tiempoFormateado: `${Math.floor(revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0) / 60)}h ${revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0) % 60}m`
            // NO incluimos tareasSinTiempo en la respuesta
          };
        })
        .filter(item => item !== null) // Filtrar nulos
    };

    // ✅ GUARDAR EN HISTORIAL - Registrar tareas conocidas y mensaje del bot
const analisisCompleto = {
  success: true,
  answer: aiResult.text,
  provider: aiResult.provider,
  sessionId: sessionId,
  proyectoPrincipal: proyectoPrincipal,
  metrics: {
    totalActividades: actividadesFiltradas.length,
    totalPendientes: totalTareasConTiempo,
    pendientesAltaPrioridad: tareasAltaPrioridad,
    tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`,
    actividadesConPendientes: actividadesFinales.length,
    tareasConTiempo: totalTareasConTiempo,
    tareasSinTiempo: totalTareasSinTiempo,
    tareasAltaPrioridad: tareasAltaPrioridad
  },
  data: respuestaData,
  separadasPorTiempo: true,
  sugerencias: []
};

// Construir tareasEstado desde las revisiones
const tareasEstadoArray = respuestaData.revisionesPorActividad.flatMap(r =>
  (r.tareasConTiempo || []).map(t => ({
    taskId: t.id,
    taskName: t.nombre,
    actividadTitulo: r.actividadTitulo,
    explicada: false,
    validada: false,
    explicacion: "",
    ultimoIntento: null
  }))
);

// Guardar historial con mensaje del usuario, respuesta del bot y tareas conocidas
await HistorialBot.findOneAndUpdate(
  { userId: odooUserId, sessionId },
  {
    $setOnInsert: {
      userId: odooUserId,
      sessionId
    },
    $set: {
      tareasEstado: tareasEstadoArray,
      ultimoAnalisis: analisisCompleto,
      estadoConversacion: "mostrando_actividades"
    },
    $push: {
      mensajes: {
        $each: [
          {
            role: "usuario",
            contenido: question,
            timestamp: new Date(),
            tipoMensaje: "texto",
            analisis: null
          },
          {
            role: "bot",
            contenido: aiResult.text,
            timestamp: new Date(),
            tipoMensaje: "analisis_inicial",
            analisis: analisisCompleto
          }
        ]
      }
    }
  },
  { upsert: true, new: true }
);

    // 1️.2 Respuesta completa
    return res.json({
      success: true,
      answer: aiResult.text,
      provider: aiResult.provider,
      sessionId: sessionId,
      proyectoPrincipal: proyectoPrincipal,
      metrics: {
        totalActividadesProgramadas: actividadesFiltradas.length,
        actividadesConTiempoTotal: Array.from(actividadesConRevisionesConTiempoIds).length,
        actividadesFinales: actividadesFinales.length,
        tareasConTiempo: totalTareasConTiempo,
        tareasAltaPrioridad: tareasAltaPrioridad,
        tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`,
        // NOTA: No incluimos métricas de tareas sin tiempo
      },
      data: respuestaData,
      multiActividad: true,
      filtrosAplicados: {
        excluir00ftf: true,
        excluir00sec: true,
        soloHorarioLaboral: "09:00-17:30",
        soloTareasConTiempo: true,
        excluirTareasSinTiempo: true
      }
      // sugerencias: [
      //   `¿Quieres ver las ${Array.from(actividadesConRevisionesConTiempoIds).length} actividades con tareas con tiempo (incluyendo fuera de horario)?`,
      //   `¿Te gustaría estimar tiempo para las ${totalTareasSinTiempo} tareas sin tiempo?`,
      //   "¿Quieres priorizar solo las tareas de alta prioridad?",
      //   "¿Necesitas ayuda para organizar mejor tu tiempo?"
      // ]
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

// Funciones originales (mantener compatibilidad)
export async function devuelveActividades(req, res) {
  try {
    const { email } = sanitizeObject(req.body);


    // Obtener el ID del usuario desde el token (viene del middleware de auth)
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const sessionUserId = decoded.id;

    const sessionId = generarSessionIdDiario(sessionUserId);

 
    const response = await axios.get(
      `${urlApi}/actividades/assignee/${email}/del-dia`
    );

    const actividadesRaw = response.data.data;

    if (!Array.isArray(actividadesRaw)) {
     
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
      
      // );
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

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id.toString();


    const sessionId = generarSessionIdDiario(odooUserId);;

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

    const { answer, data } = sanitizeObject(req.body);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id.toString();

    if (
      !userId ||
      !data?.actividades?.length ||
      !data?.revisionesPorActividad?.length
    ) {
      return res.status(400).json({
        error: "JSON incompleto para guardar pendientes"
      });
    }

    const actividad = data.actividades[0];
    const revision = data.revisionesPorActividad.find(
      r => r.actividadId === actividad.id
    );

    if (!revision) {
      return res.status(400).json({
        error: "No hay revisión para la actividad"
      });
    }

    // 🔁 Mapear pendientes al schema real
    const pendientesMapeados = revision.pendientes.map(p => ({
      pendienteId: p.id,
      nombre: p.nombre,
      descripcion: "",
      estado: p.terminada ? "completado" : "pendiente"
    }));

    const sessionId = generarSessionIdDiario(userId);

    // 🔍 Buscar o crear actividad
    const actividadDB = await ActividadesSchema.findOneAndUpdate(
      {
        userId,
        nombre: actividad.titulo
      },
      {
        $setOnInsert: {
          userId,
          nombre: actividad.titulo
        },
        $push: {
          pendientes: { $each: pendientesMapeados }
        }
      },
      {
        new: true,
        upsert: true
      }
    );

 

    res.status(201).json({
      success: true,
      actividad: actividadDB.nombre,
      pendientesGuardados: pendientesMapeados.length,
      sessionId
    });

  } catch (error) {
    console.error("Error en guardarPendientes:", error);
    res.status(500).json({ error: error.message });
  }
}


/**
 * Obtiene el historial de una sesión específica
 */

export async function obtenerHistorialSesion(req, res) {
  try {
    const { token } = req.cookies;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No autenticado"
      });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id.toString();
    const sessionId = generarSessionIdDiario(userId);

    // Buscar historial y actividades en paralelo
    const [historial, actividades] = await Promise.all([
      HistorialBot.findOne({ userId, sessionId }).lean(),
      ActividadesSchema.findOne({ userId }).lean()
    ]);

    if (!historial) {
      return res.json({
        success: true,
        data: null,
        actividades: actividades || null
      });
    }

    /* --------------------------------------------------
       FILTRAR ACTIVIDADES SOLO CON REVISIONES
    -------------------------------------------------- */
    if (
      historial?.ultimoAnalisis?.data?.revisionesPorActividad &&
      historial?.ultimoAnalisis?.data?.actividades
    ) {
      const idsConRevision = new Set(
        historial.ultimoAnalisis.data.revisionesPorActividad.map(
          r => r.actividadId
        )
      );

      historial.ultimoAnalisis.data.actividades =
        historial.ultimoAnalisis.data.actividades.filter(a =>
          idsConRevision.has(a.id)
        );
    }

    /* --------------------------------------------------
       CRUZAR ESTADO DE TAREAS CON PENDIENTES
    -------------------------------------------------- */
    if (
      historial?.tareasEstado?.length &&
      historial?.ultimoAnalisis?.data?.revisionesPorActividad
    ) {
      const estadoPorTarea = new Map(
        historial.tareasEstado.map(t => [t.taskId, t])
      );

      historial.ultimoAnalisis.data.revisionesPorActividad.forEach(revision => {
        revision.pendientes.forEach(pendiente => {
          const estado = estadoPorTarea.get(pendiente.id);

          if (estado) {
            // Restauramos el estado de validación previo
            tarea.confirmada = estado.validada;
            tarea.explicacion = estado.explicacion;
            tarea.explicada = true; // Flag para que el frontend sepa que ya no debe pedirla
          } else {
            tarea.confirmada = false;
            tarea.explicada = false;
          }
        });
      });
    }

    return res.json({
      success: true,
      data: historial,
      actividades: actividades || null
    });

  } catch (error) {
    console.error("Error en validarExplicacion:", error);
    return res.status(500).json({
      valida: false,
      razon: "Error interno al procesar la validación."
    });
  }
}




export async function confirmarEstadoPendientes(req, res) {
  try {
    const { actividadesId, IdPendientes, estado, motivoNoCompletado } = sanitizeObject(req.body);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id.toString();

    if (!actividadesId || !IdPendientes || !estado) {
      return res.status(400).json({
        success: false,
        message: "actividadesId, IdPendientes y estado son requeridos"
      });
    }

    // Actualizamos el estado del pendiente dentro de la actividad del proyecto
    const resultado = await ProyectosSchema.updateOne(
      {
        userId,
        'actividades.ActividadId': actividadesId,
        'actividades.pendientes.pendienteId': IdPendientes
      },
      {
        $set: {
          'actividades.$[act].pendientes.$[pen].estado': estado,
          'actividades.$[act].pendientes.$[pen].motivoNoCompletado': motivoNoCompletado
        }
      },
      {
        arrayFilters: [
          { 'act.ActividadId': actividadesId },
          { 'pen.pendienteId': IdPendientes }
        ]
      }
    );

    return res.json({
      success: true,
      message: "Estado actualizado correctamente",
      data: resultado
    });
  } catch (error) {
    console.error("Error actualizando estado:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno"
    });
  }
}

export async function validarExplicacion(req, res) {
  try {
    const { taskName, explanation, activityTitle } = sanitizeObject(req.body);
    const cleanTitle = activityTitle.replace(/,/g, ' ');

    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({ valida: false, razon: "No autenticado" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id.toString();
    const sessionId = generarSessionIdDiario(userId);

    console.log(explanation);

    const prompt = `
Eres un asistente que verifica si un comentario está relacionado
con una tarea específica o con algo necesario para poder trabajar en ella hoy.

CONTEXTO:
- Actividad: "${cleanTitle}"
- Tarea: "${taskName}"
- Comentario del usuario: "${explanation}"

INSTRUCCIONES:
- Considera relacionado si el comentario:
  - Describe acciones sobre la tarea, o
  - Menciona algo necesario para poder avanzar en ella hoy
    (por ejemplo: herramientas, equipo, bloqueos prácticos).
- No evalúes calidad, detalle ni redacción.
- Comentarios breves o informales son aceptables.
- Solo marca como no relacionado si habla de un tema totalmente distinto
  o no se entiende ninguna intención.

RESPONDE ÚNICAMENTE EN JSON:
{
  "esDelTema": true o false,
  "razon": "Frase corta (máx 10 palabras)",
  "sugerencia": "Pregunta corta para orientar al usuario (vacía si esDelTema es true)"
}
`;

    const aiResult = await smartAICall(prompt);
    const text = aiResult?.text;

    if (!text) {
      return res.status(500).json({ valida: false, razon: "La IA no respondió." });
    }

    // Extracción robusta del JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ valida: false, razon: "Formato de IA inválido." });
    }

    const resultadoIA = JSON.parse(jsonMatch[0]);
    console.log(resultadoIA);

    // 1️⃣ PRIMERO: Crear la respuesta
    const respuesta = {
      valida: resultadoIA.esDelTema === true,
      categoriaMotivo: resultadoIA.categoriaMotivo || "INSUFICIENTE",
      razon: resultadoIA.razon || "Revisión técnica necesaria.",
      sugerencia: resultadoIA.sugerencia || "",
    };

    // 2️⃣ DESPUÉS: Actualizar historial según el resultado
    if (respuesta.valida) {
      // Explicación válida - marcar tarea como explicada
      await HistorialBot.updateOne(
        {
          userId,
          sessionId,
          "tareasEstado.taskName": taskName
        },
        {
          $set: {
            "tareasEstado.$.validada": true,
            "tareasEstado.$.explicada": true,
            "tareasEstado.$.explicacion": explanation,
            "tareasEstado.$.ultimoIntento": new Date()
          }
        }
      );
    } else {
      // Explicación inválida - solo registrar intento
      await HistorialBot.updateOne(
        {
          userId,
          sessionId,
          "tareasEstado.taskName": taskName
        },
        {
          $set: {
            "tareasEstado.$.ultimoIntento": new Date()
          }
        }
      );
    }

    // 3️⃣ Guardar mensajes en historial
    await HistorialBot.updateOne(
      { userId, sessionId },
      {
        $push: {
          mensajes: {
            $each: [
              {
                role: "usuario",
                contenido: `[Explicación para "${taskName}"]: ${explanation}`,
                timestamp: new Date(),
                tipoMensaje: "texto"
              },
              {
                role: "bot",
                contenido: respuesta.valida
                  ? `Explicación válida: ${respuesta.razon}`
                  : `${respuesta.razon}. ${respuesta.sugerencia || ''}`,
                timestamp: new Date(),
                tipoMensaje: "respuesta_ia"
              }
            ]
          }
        }
      }
    );

    // Log para monitoreo
    if (!respuesta.valida) {
      console.log(`[Validación Fallida] Tarea: ${taskName} | Motivo: ${respuesta.categoriaMotivo}`);
    }

    return res.json(respuesta);

  } catch (error) {
    console.error("Error en validarExplicacion:", error);
    return res.status(500).json({
      valida: false,
      razon: "Error interno al procesar la validación."
    });
  }
}

export async function guardarExplicaciones(req, res) {
  try {
    const { explanations } = sanitizeObject(req.body);

    console.log(explanations);

    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token requerido"
      });
    }

    const { id: userId } = jwt.verify(token, TOKEN_SECRET);

    if (!Array.isArray(explanations) || explanations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No hay explicaciones para guardar"
      });
    }

    let totalGuardadas = 0;

    for (const exp of explanations) {
      const {
        taskId,
        taskName,
        explanation,
        confirmed,
        activityTitle,
        duration,
        priority
      } = exp;

      if (!taskId || !taskName || !explanation || !activityTitle) continue;

      // Busca la actividad
      let actividad = await ActividadesSchema.findOne({
        userId,
        nombre: activityTitle
      });

      if (!actividad) {
        actividad = await ActividadesSchema.create({
          userId,
          nombre: activityTitle,
          pendientes: []
        });
      }

      // Verifica si ya existe el pendiente
      const pendienteExistente = actividad.pendientes.find(
        p => p.pendienteId === taskId
      );

      if (pendienteExistente) {
        // Actualiza si ya existe
        pendienteExistente.descripcion = explanation;
        pendienteExistente.estado = confirmed ? "completado" : "pendiente";
        pendienteExistente.duracionMin = duration ?? pendienteExistente.duracionMin;
        pendienteExistente.prioridad = priority ?? pendienteExistente.prioridad;
      } else {
        // Crea un nuevo pendiente
        actividad.pendientes.push({
          pendienteId: taskId,
          nombre: taskName,
          descripcion: explanation,
          estado: confirmed ? "completado" : "pendiente",
          duracionMin: duration ?? 0,
          prioridad: priority ?? "BAJA"
        });
      }

      await actividad.save();
      totalGuardadas++;
    }

    return res.status(200).json({
      success: true,
      message: "Pendientes guardados correctamente",
      totalGuardadas
    });

  } catch (error) {
    console.error("Error en guardarExplicaciones:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al guardar explicaciones",
      error: error.message
    });
  }
}

export async function obtenerSiguienteTarea(req, res) {
  try {
    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({ success: false, message: "No autenticado" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id.toString();
    const sessionId = generarSessionIdDiario(userId);

    const historial = await HistorialBot.findOne({ userId, sessionId });

    if (!historial || !historial.tareasEstado?.length) {
      return res.json({
        success: true,
        hayPendientes: false,
        mensaje: "No hay tareas registradas para hoy"
      });
    }

    const siguienteTarea = historial.tareasEstado.find(t => !t.validada);

    if (!siguienteTarea) {
      return res.json({
        success: true,
        hayPendientes: false,
        todasCompletadas: true,
        mensaje: "¡Todas las tareas han sido explicadas!"
      });
    }

    const totalTareas = historial.tareasEstado.length;
    const tareasCompletadas = historial.tareasEstado.filter(t => t.validada).length;

    return res.json({
      success: true,
      hayPendientes: true,
      siguienteTarea: {
        taskId: siguienteTarea.taskId,
        taskName: siguienteTarea.taskName,
        actividadTitulo: siguienteTarea.actividadTitulo
      },
      progreso: {
        completadas: tareasCompletadas,
        total: totalTareas,
        porcentaje: Math.round((tareasCompletadas / totalTareas) * 100)
      }
    });

  } catch (error) {
    console.error("Error en obtenerSiguienteTarea:", error);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
}