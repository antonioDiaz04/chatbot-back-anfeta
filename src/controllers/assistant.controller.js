import axios from 'axios';
import { getAllUsers } from './users.controller.js';
import jwt from 'jsonwebtoken';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { smartAICall } from '../libs/aiService.js';
import { guardarMensajeHistorial } from '../libs/guardarHistorial.js';
import { generarSessionIdDiario } from '../libs/generarSessionIdDiario.js';
import { horaAMinutos } from '../libs/horaAMinutos.js';
import ActividadesSchema from "../models/actividades.model.js";
import HistorialBot from "../models/historialBot.mode.js";
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
    const sessionId = `act_${email}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_');

    const usersData = await getAllUsers();
    const user = usersData.items.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const { sessionUserId } = req.cookies;
    const odooUserId = sessionUserId;

    // ✅ Guardar mensaje del usuario en historial
    await guardarMensajeHistorial(odooUserId, sessionId, "usuario", question);

    // 1️ Obtener actividades del día para el usuario
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

      // ✅ Guardar respuesta del bot en historial
      // await guardarMensajeHistorial(odooUserId, sessionId, "bot", mensajeError);

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

    //  Guardar respuesta del bot en historial
    await guardarMensajeHistorial(odooUserId, sessionId, "bot", aiResult.text);

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

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;


    const sessionId = generarSessionIdDiario(odooUserId);;

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

    const { answer, data } = sanitizeObject(req.body);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

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

    // 🧠 Guardar mensaje usuario
    await guardarMensajeHistorial(
      userId,
      sessionId,
      "usuario",
      `Guardando ${pendientesMapeados.length} pendientes`
    );

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

    // 🧠 Guardar análisis completo en historial
    await HistorialBot.findOneAndUpdate(
      { userId, sessionId },
      {
        $push: {
          mensajes: {
            role: "bot",
            contenido: answer,
            tipoMensaje: "respuesta_ia",
            analisis: body
          }
        },
        $set: {
          ultimoAnalisis: body,
          estadoConversacion: "finalizado"
        }
      },
      { upsert: true }
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
      return res.status(401).json({ success: false, message: "No autenticado" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;


    const sessionId = generarSessionIdDiario(userId);

    // Buscamos el historial y los proyectos en paralelo
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

    // Lógica de filtrado: solo actividades que tengan revisión (pendientes)
    if (
      historial.data &&
      Array.isArray(historial.data.revisionesPorActividad) &&
      Array.isArray(historial.data.actividades)
    ) {
      const idsConRevision = new Set(
        historial.data.revisionesPorActividad.map(r => r.actividadId)
      );

      historial.data.actividades = historial.data.actividades.filter(
        actividad => idsConRevision.has(actividad.id)
      );
    }


    return res.json({
      success: true,
      data: historial,
      actividades: actividades || null
    });

  } catch (error) {
    console.error("Error al obtener sesión específica:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor"
    });
  }
}


/**
 * Obtiene todos los historiales de un usuario con paginación
 */
export async function obtenerHistorialesUsuario(req, res) {
  try {
    const { limit = 10, skip = 0 } = sanitizeObject(req.query);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;



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
    const { sessionId } = sanitizeObject(req.body);



    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;



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

export async function confirmarEstadoPendientes(req, res) {
  try {
    const { actividadesId, IdPendientes, estado, motivoNoCompletado } = sanitizeObject(req.body);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

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

/**
 * Función 2 - Versión local simplificada para pruebas
 * Solo procesa 2 tareas de ejemplo sin conexiones externas
 */
export async function getActividadesLocal(req, res) {
  try {
    const { email, question = "¿Qué tengo pendiente hoy?" } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "El email es requerido"
      });
    }

    // ID de sesión simple
    const sessionId = `local_${Date.now()}`;

    // 1. Datos de usuario local (simulado)
    const usuarioLocal = {
      id: 1,
      email: email,
      firstName: "Usuario",
      lastName: "Demo",
      role: "developer"
    };

    // 2. Actividades locales fijas (solo 2)
    const actividadesLocales = [
      {
        id: 101,
        titulo: "Revisar documentación técnica",
        horaInicio: "09:00",
        horaFin: "10:30",
        status: "Pendiente",
        tituloProyecto: "Proyecto Local Alpha"
      },
      {
        id: 102,
        titulo: "Corregir errores en formulario",
        horaInicio: "11:00",
        horaFin: "12:00",
        status: "En progreso",
        tituloProyecto: "Proyecto Local Beta"
      }
    ];

    // 3. Revisiones locales fijas (asociadas a las 2 actividades)
    const fechaAyer = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const revisionesLocales = {
      colaboradores: [
        {
          items: {
            actividades: [
              {
                id: 101,
                pendientes: [
                  {
                    id: 201,
                    nombre: "Revisar API endpoints",
                    terminada: false,
                    confirmada: false,
                    duracionMin: 45,
                    fechaCreacion: fechaAyer,
                    assignees: [{ name: email }]
                  },
                  {
                    id: 202,
                    nombre: "Actualizar diagramas",
                    terminada: true,
                    confirmada: true,
                    duracionMin: 30,
                    fechaCreacion: fechaAyer,
                    assignees: [{ name: email }]
                  }
                ]
              },
              {
                id: 102,
                pendientes: [
                  {
                    id: 203,
                    nombre: "Validar inputs del formulario",
                    terminada: false,
                    confirmada: false,
                    duracionMin: 0, // Sin tiempo asignado
                    fechaCreacion: fechaAyer,
                    assignees: [{ name: email }]
                  }
                ]
              }
            ]
          }
        }
      ]
    };
    // 4. Procesar revisiones para cada actividad
    const revisionesPorActividad = {};

    actividadesLocales.forEach(actividad => {
      const actividadRevisiones = revisionesLocales.colaboradores[0].items.actividades
        .find(a => a.id === actividad.id);

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

      if (actividadRevisiones && actividadRevisiones.pendientes) {
        actividadRevisiones.pendientes.forEach(pendiente => {
          const pendienteInfo = {
            id: pendiente.id,
            nombre: pendiente.nombre,
            terminada: pendiente.terminada,
            confirmada: pendiente.confirmada,
            duracionMin: pendiente.duracionMin || 0,
            fechaCreacion: pendiente.fechaCreacion,
            diasPendiente: pendiente.fechaCreacion ?
              Math.floor((new Date() - new Date(pendiente.fechaCreacion)) / (1000 * 60 * 60 * 24)) : 0
          };

          if (pendiente.duracionMin && pendiente.duracionMin > 0) {
            pendienteInfo.prioridad = pendiente.duracionMin > 60 ? "ALTA" :
              pendiente.duracionMin > 30 ? "MEDIA" : "BAJA";
            revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);
          } else {
            pendienteInfo.prioridad = "SIN TIEMPO";
            revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
          }
        });
      }
    });

    // 5. Calcular métricas simples
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0;
    let tiempoTotalEstimado = 0;

    Object.values(revisionesPorActividad).forEach(actividad => {
      totalTareasConTiempo += actividad.pendientesConTiempo.length;
      totalTareasSinTiempo += actividad.pendientesSinTiempo.length;
      tiempoTotalEstimado += actividad.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;

    // 6. Respuesta local sin IA
    const respuestaLocal = `
Hola ${usuarioLocal.firstName},

Tienes 2 actividades locales programadas para hoy:

1. Revisar documentación técnica (09:00-10:30)
   • 2 tareas: 1 pendiente (45min), 1 completada

2. Corregir errores en formulario (11:00-12:00)
   • 1 tarea sin tiempo estimado

Total: ${totalTareasConTiempo} tareas con tiempo (${horasTotales}h ${minutosTotales}m), 
${totalTareasSinTiempo} tareas sin tiempo.

¿En qué actividad te gustaría enfocarte primero?
    `.trim();

    // 7. Devolver respuesta estructurada
    return res.json({
      success: true,
      answer: respuestaLocal,
      sessionId: sessionId,
      source: "local_demo",
      metrics: {
        totalActividades: actividadesLocales.length,
        tareasConTiempo: totalTareasConTiempo,
        tareasSinTiempo: totalTareasSinTiempo,
        tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`
      },
      data: {
        actividades: actividadesLocales.map(a => ({
          id: a.id,
          titulo: a.titulo,
          horario: `${a.horaInicio} - ${a.horaFin}`,
          status: a.status,
          proyecto: a.tituloProyecto
        })),
        revisionesPorActividad: Object.values(revisionesPorActividad).map(item => ({
          actividadId: item.actividad.id,
          actividadTitulo: item.actividad.titulo,
          tareasConTiempo: item.pendientesConTiempo,
          tareasSinTiempo: item.pendientesSinTiempo,
          totalTareas: item.pendientesConTiempo.length + item.pendientesSinTiempo.length
        }))
      },
      sugerencias: [
        "¿Quieres marcar alguna tarea como completada?",
        "¿Necesitas agregar tiempo estimado a las tareas sin tiempo?",
        "¿Quieres ver más detalles de alguna actividad?"
      ],
      nota: "Esta es una versión local de demostración con datos fijos"
    });

  } catch (error) {
    console.error("Error en función local:", error);
    return res.status(500).json({
      success: false,
      message: "Error en función local",
      error: error.message
    });
  }
}