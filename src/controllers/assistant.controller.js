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
    const odooUserId = decoded.id;

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
    const promptNombreConversacion = `
Genera un TÍTULO MUY CORTO para una conversación.

ACTIVIDADES:
${actividadesFinales.map(a => `- ${a.titulo}`).join('\n')}

CONTEXTO:
- Proyecto principal: "${proyectoPrincipal}"
- Tareas con tiempo: ${totalTareasConTiempo}
- Tareas alta prioridad: ${tareasAltaPrioridad}

REGLAS OBLIGATORIAS:
- MÁXIMO 2 PALABRAS
- Solo letras y espacios
- Sin emojis
- Sin signos de puntuación
- No frases completas
- Idioma español
- Usa la palabra más REPRESENTATIVA de las actividades
- Si hay un proyecto claro, úsalo

FORMATOS VÁLIDOS:
- "<Tema>"
- "<Tema> hoy"
- "<Proyecto>"
- "<Proyecto> tareas"

EJEMPLOS CORRECTOS:
- "ANFETA"
- "Pendientes"
- "Soporte hoy"
- "Migración tareas"
- "Backend urgente"

RESPONDE SOLO EL TÍTULO
`.trim();


    let nombreConversacionIA = "Nueva conversación";

    try {
      const aiNombre = await smartAICall(promptNombreConversacion);
      if (aiNombre?.text) {
        nombreConversacionIA = aiNombre.text.trim().slice(0, 60);
      }
    } catch (e) {
      console.warn("No se pudo generar nombre de conversación con IA");
    }

    // Guardar historial con mensaje del usuario, respuesta del bot y tareas conocidas
    await HistorialBot.findOneAndUpdate(
      { userId: odooUserId, sessionId },
      {
        $setOnInsert: {
          userId: odooUserId,
          sessionId,
          nombreConversacion: nombreConversacionIA
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

    await ActividadesSchema.findOneAndUpdate(
      { odooUserId: odooUserId },
      {
        $set: {
          odooUserId: odooUserId,
          actividades: respuestaData.revisionesPorActividad.map(rev => ({
            actividadId: rev.actividadId,
            titulo: rev.actividadTitulo,
            horaInicio: rev.actividadHorario.split(' - ')[0],
            horaFin: rev.actividadHorario.split(' - ')[1],
            status: "activo",
            fecha: new Date().toISOString().split('T')[0],
            pendientes: rev.tareasConTiempo.map(t => ({
              pendienteId: t.id,
              nombre: t.nombre,
              descripcion: "",
              terminada: t.terminada,
              confirmada: t.confirmada,
              duracionMin: t.duracionMin,
              fechaCreacion: t.fechaCreacion,
              fechaFinTerminada: t.fechaFinTerminada,
            })),
            ultimaActualizacion: new Date()
          })),
          ultimaSincronizacion: new Date()
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

export async function obtenerActividadesConTiempoHoy(req, res) {
  try {
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    const hoy = new Date().toISOString().split('T')[0];

    // Buscar actividades del usuario
    const registroUsuario = await ActividadesSchema.findOne({ odooUserId }).lean();

    if (!registroUsuario || !registroUsuario.actividades) {
      return res.json({
        success: true,
        data: [],
        message: "No se encontraron actividades para hoy"
      });
    }

    // Filtrar actividades de hoy con pendientes que tienen tiempo
    const actividadesDeHoy = registroUsuario.actividades
      .filter(actividad => actividad.fecha === hoy)
      .map(actividad => {
        // Solo pendientes con tiempo y no terminados
        const pendientesConTiempo = actividad.pendientes.filter(p =>
          p.duracionMin && p.duracionMin > 0 && !p.terminada
        );

        if (pendientesConTiempo.length === 0) return null;

        return {
          actividadId: actividad.actividadId,
          titulo: actividad.titulo,
          tituloProyecto: actividad.tituloProyecto,
          horaInicio: actividad.horaInicio,
          horaFin: actividad.horaFin,
          status: actividad.status,
          pendientes: pendientesConTiempo.map(p => ({
            pendienteId: p.pendienteId,
            nombre: p.nombre,
            descripcion: p.descripcion,
            duracionMin: p.duracionMin,
            terminada: false,
            motivoNoCompletado: null // Para llenar después
          }))
        };
      })
      .filter(act => act !== null)
      .sort((a, b) => horaAMinutos(a.horaInicio) - horaAMinutos(b.horaInicio));

    if (actividadesDeHoy.length === 0) {
      return res.json({
        success: true,
        data: [],
        message: "No tienes tareas pendientes con tiempo para hoy"
      });
    }

    return res.json({
      success: true,
      data: actividadesDeHoy,
      totalActividades: actividadesDeHoy.length,
      totalTareas: actividadesDeHoy.reduce((sum, act) => sum + act.pendientes.length, 0)
    });

  } catch (error) {
    console.error("Error en obtenerActividadesConTiempoHoy:", error);
    return res.status(500).json({
      success: false,
      message: "Error al obtener actividades",
      error: error.message
    });
  }
}

export async function actualizarEstadoPendientes(req, res) {
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

export async function validarExplicacion(req, res) {
  try {
    const { taskName, explanation, activityTitle } = sanitizeObject(req.body);
    const cleanTitle = activityTitle.replace(/,/g, ' ');

    const { token } = req.cookies;



    console.log(explanation)

    const prompt = `
Eres un asistente que valida si un comentario del usuario
está realmente relacionado con una tarea específica
o con algo necesario para poder avanzar en ella HOY.

CONTEXTO:
- Actividad: "${cleanTitle}"
- Tarea: "${taskName}"
- Comentario del usuario: "${explanation}"

CRITERIOS PARA CONSIDERARLO RELACIONADO:
Marca como relacionado SOLO si el comentario:
- Describe una acción que hará, hizo o intentó sobre la tarea, o
- Explica algo necesario para poder avanzar hoy
  (bloqueos reales, herramientas, accesos, información faltante).

CRITERIOS PARA NO RELACIONADO:
Marca como NO relacionado si:
- El usuario dice explícitamente que no hará nada,
- Habla de un tema distinto (personal, general, sin relación),
- Es una respuesta evasiva o sin intención clara de trabajar la tarea.

REGLAS IMPORTANTES:
- NO evalúes calidad, ortografía ni nivel de detalle.
- Comentarios breves o informales son válidos.
- Sé estricto pero justo: duda razonable = relacionado.
- Si NO es relacionado, explica claramente qué faltó.

RESPONDE ÚNICAMENTE EN JSON CON ESTE FORMATO EXACTO:
{
  "esDelTema": true | false,
  "razon": "Explicación breve y concreta del motivo",
  "sugerencia": "Pregunta clara para que el usuario corrija o explique mejor (vacía si esDelTema es true)",
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


    // Estructura de respuesta final (reutilizable para la misma ruta)
    const respuesta = {
      valida: resultadoIA.esDelTema === true,
      categoriaMotivo: resultadoIA.categoriaMotivo || "INSUFICIENTE",
      razon: resultadoIA.razon || "Revisión técnica necesaria.",
      sugerencia: resultadoIA.sugerencia,
    };

    // Log para monitoreo interno
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
    const { explanations, sessionId } = sanitizeObject(req.body);
    const { token } = req.cookies;

    if (!Array.isArray(explanations)) {
      return res.status(400).json({ error: "No se recibieron explicaciones válidas" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    console.log(explanations);

    // 1. Documento raíz del usuario
    let registroUsuario = await ActividadesSchema.findOne({ odooUserId });

    if (!registroUsuario) {
      registroUsuario = await ActividadesSchema.create({
        odooUserId,
        actividades: []
      });
    }

    // 2. Procesar explicaciones
    for (const exp of explanations) {

      // Buscar / crear actividad
      let actividad = registroUsuario.actividades.find(
        a => a.titulo === exp.activityTitle
      );

      if (!actividad) {
        registroUsuario.actividades.push({
          actividadId: `ACT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          titulo: exp.activityTitle,
          fecha: new Date().toISOString().split("T")[0],
          pendientes: []
        });

        actividad = registroUsuario.actividades.at(-1);
      }

      // 3. Buscar pendiente (USANDO id)
      const pendienteIndex = actividad.pendientes.findIndex(
        (p) => p.pendienteId === exp.taskId
      );

      const datosPendiente = {
        pendienteId: exp.taskId,
        nombre: exp.taskName,
        descripcion: exp.explanation,
        terminada: !!exp.confirmed,
        confirmada: !!exp.confirmed,
        duracionMin: exp.duration || 0,
        updatedAt: new Date()
      };


      if (pendienteIndex !== -1) {
        actividad.pendientes[pendienteIndex].descripcion = exp.explanation;
        actividad.pendientes[pendienteIndex].terminada = !!exp.confirmed;
        actividad.pendientes[pendienteIndex].confirmada = !!exp.confirmed;
        actividad.pendientes[pendienteIndex].duracionMin = exp.duration || 0;
        actividad.pendientes[pendienteIndex].updatedAt = new Date();
      } else {
        actividad.pendientes.push({
          ...datosPendiente,
          createdAt: new Date()
        });
      }

    }

    registroUsuario.ultimaSincronizacion = new Date();
    await registroUsuario.save();

    // 4. Historial del bot
    const historial = await HistorialBot.findOne({ sessionId });

    if (historial) {
      explanations.forEach(exp => {
        const estadoIndex = historial.tareasEstado.findIndex(
          t => t.taskId === exp.taskId
        );

        const nuevoEstado = {
          taskId: exp.taskId,
          taskName: exp.taskName,
          actividadTitulo: exp.activityTitle,
          explicada: true,
          validada: exp.confirmed || false,
          explicacion: exp.explanation,
          ultimoIntento: new Date()
        };

        if (estadoIndex !== -1) {
          historial.tareasEstado.set(estadoIndex, nuevoEstado);
        } else {
          historial.tareasEstado.push(nuevoEstado);
        }
      });

      historial.mensajes.push({
        role: "bot",
        contenido: `He guardado las descripciones de ${explanations.length} tareas correctamente.`,
        tipoMensaje: "sistema",
        timestamp: new Date()
      });

      historial.estadoConversacion = "finalizado";
      await historial.save();
    }

    return res.status(200).json({
      success: true,
      message: "Explicaciones guardadas con éxito",
      total: explanations.length,
      sessionId
    });

  } catch (error) {
    console.error("Error en guardarExplicaciones:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}


export async function confirmarEstadoPendientes(req, res) {
  try {
    const { pendienteId, actividadId, transcript } = sanitizeObject(req.body);

    if (!actividadId || !pendienteId || !transcript) {
      return res.status(400).json({
        success: false,
        message: "actividadId, pendienteId y transcript son requeridos",
        recibido: { actividadId, pendienteId, transcript }
      });
    }

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    // 3. Buscar el contexto para la IA (Plan de la mañana)
    const registro = await ActividadesSchema.findOne(
      { odooUserId, "actividades.actividadId": actividadId },
      { "actividades.$": 1 }
    );

    if (!registro) {
      return res.status(404).json({ success: false, message: "Actividad no encontrada" });
    }

    const pendienteOriginal = registro.actividades[0].pendientes.find(p => p.pendienteId === pendienteId);

    // 4. Llamada Inteligente a la IA
    const prompt = `
      Analiza si el reporte de voz confirma la realización de la tarea.
      TAREA: "${pendienteOriginal.nombre}"
      REPORTE: "${transcript}"
      Responde SOLO JSON: {"esValido": boolean, "razon": "por qué no", "mensaje": "feedback"}
    `;

    const aiResponse = await smartAICall(prompt);
    const validacion = JSON.parse(aiResponse.text.match(/\{.*\}/s)[0]);

    // 5. Actualizar MongoDB (Usando el esquema Actividades que mostraste al inicio)
    const resultado = await ActividadesSchema.updateOne(
      { odooUserId, "actividades.actividadId": actividadId },
      {
        $set: {
          // 'terminada' y 'confirmada' según tu esquema
          "actividades.$.pendientes.$[pen].terminada": validacion.esValido,
          "actividades.$.pendientes.$[pen].confirmada": true,
          "actividades.$.pendientes.$[pen].motivoNoCompletado": validacion.esValido ? "" : validacion.razon,
          "actividades.$.pendientes.$[pen].fechaFinTerminada": validacion.esValido ? new Date() : null
        }
      },
      {
        arrayFilters: [{ "pen.pendienteId": pendienteId }]
      }
    );

    return res.json({
      success: true,
      terminada: validacion.esValido,
      mensaje: validacion.mensaje,
      provider: aiResponse.provider
    });

  } catch (error) {
    console.error("Error en confirmarEstadoPendientes:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al validar con IA",
      error: error.message
    });
  }
}

export async function obtenerHistorialSesion(req, res) {
  try {
    const { token } = req.cookies;
    let { sessionId } = req.params;

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

    if (!sessionId) {
      sessionId = generarSessionIdDiario(userId);
    }

    if (!token) {
      return res.status(401).json({ success: false, message: "No autenticado" });
    }

    const historial = await HistorialBot.findOne({ userId, sessionId }).lean();

    const actividadesCache = await ActividadesSchema.findOne({
      odooUserId: userId
    }).lean();

    const actividadesProcesadas = actividadesCache ? {
      odooUserId: actividadesCache.odooUserId,
      ultimaSincronizacion: actividadesCache.ultimaSincronizacion,
      actividades: (actividadesCache.actividades || []).map(act => ({
        actividadId: act.actividadId,
        titulo: act.titulo,
        tituloProyecto: act.tituloProyecto,
        status: act.status,
        fecha: act.fecha,
        pendientes: (act.pendientes || []).map(p => ({
          pendienteId: p.pendienteId,
          nombre: p.nombre,
          descripcion: p.descripcion || "",
          terminada: p.terminada,
          confirmada: p.confirmada,
          duracionMin: p.duracionMin,
          fechaCreacion: p.fechaCreacion,
          fechaFinTerminada: p.fechaFinTerminada
        }))
      }))
    } : null;

    if (!historial) {
      return res.json({
        success: true,
        data: null,
        actividades: actividadesProcesadas,
        cache: {
          disponible: !!actividadesCache,
          ultimaSincronizacion: actividadesCache?.ultimaSincronizacion || null
        }
      });
    }

    return res.json({
      success: true,
      data: {
        ...historial,
        ultimoAnalisis: historial.ultimoAnalisis
      },
      actividades: actividadesProcesadas,
      cache: {
        disponible: !!actividadesCache,
        ultimaSincronizacion: actividadesCache?.ultimaSincronizacion || null,
        totalActividades: actividadesCache?.actividades?.length || 0
      },
      meta: {
        userId,
        sessionId,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("❌ Error al obtener sesión:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

export async function obtenerTodoHistorialSesion(req, res) {
  try {
    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({ success: false, message: "No autenticado" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

    const hoy = new Date();
    const unaSemanaAtras = new Date(hoy.setDate(hoy.getDate() - 7));
    unaSemanaAtras.setHours(0, 0, 0, 0);
    const historialesSemana = await HistorialBot.find({
      userId,
      createdAt: { $gte: unaSemanaAtras }
    })
      .sort({ createdAt: -1 })
      .lean();

    const actividadesCache = await ActividadesSchema.findOne({
      odooUserId: userId
    }).lean();

    const todasLasTareasValidadas = historialesSemana.reduce((acc, historial) => {
      if (historial.tareasEstado && Array.isArray(historial.tareasEstado)) {
        return [...acc, ...historial.tareasEstado];
      }
      return acc;
    }, []);

    return res.json({
      success: true,
      data: historialesSemana[0] || {},
      historialSemanal: historialesSemana,
      actividades: actividadesCache?.actividades || [],
      tareasEstado: todasLasTareasValidadas,
      cache: {
        disponible: !!actividadesCache,
        ultimaSincronizacion: actividadesCache?.ultimaSincronizacion || null
      },
      meta: {
        rango: "7 días",
        totalSesiones: historialesSemana.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("❌ Error al obtener el historial semanal:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

export async function obtenerHistorialSidebar(req, res) {
  try {
    const { token } = req.cookies;
    if (!token) {
      return res.status(401).json({ success: false, message: "Token requerido" });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

    const historial = await HistorialBot.find({ userId })
      .select("sessionId nombreConversacion userId estadoConversacion createdAt updatedAt")
      .sort({
        estadoConversacion: 1,
        updatedAt: -1
      })
      .lean();

    const data = historial.map((conv) => ({
      sessionId: conv.sessionId,
      nombreConversacion: conv.nombreConversacion?.trim() || `Chat ${new Date(conv.createdAt).toLocaleDateString()}`,
      userId: conv.userId,
      estadoConversacion: conv.estadoConversacion,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt?.toISOString() || conv.createdAt.toISOString(),
    }));

    res.json({ success: true, data });

  } catch (error) {
    console.error("Error al obtener historial sidebar:", error);
    res.status(500).json({
      success: false,
      message: "Error interno del servidor"
    });
  }
}


