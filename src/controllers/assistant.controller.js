import axios from 'axios';
import { getAllUsers } from './users.controller.js';
import jwt from 'jsonwebtoken';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { parseAIJSONSafe, smartAICall } from '../libs/aiService.js';
import { generarSessionIdDiario, obtenerSesionActivaDelDia } from '../libs/generarSessionIdDiario.js';
import memoriaService from '../Helpers/MemoriaService.helpers.js';
import ActividadesSchema from "../models/actividades.model.js";
import HistorialBot from "../models/historialBot.model.js";
import { guardarMensajeHistorial } from '../Helpers/historial.helper.js';
import { TOKEN_SECRET, API_URL_ANFETA } from '../config.js';
import { convertirHoraADecimal } from '../libs/horaAMinutos.js';

const HORARIO_INICIO = 9.5; //9:30 am
const HORARIO_FIN = 17.0;   //5:00 pm

export async function verificarAnalisisDelDia(req, res) {
  try {
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const { id: userId } = decoded;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Usuario no autenticado"
      });
    }

    // Obtener sesión activa del día
    const sessionId = await obtenerSesionActivaDelDia(userId);

    // Buscar si ya existe un análisis para esta sesión
    const historialExistente = await HistorialBot.findOne({
      userId: userId,
      sessionId: sessionId,
      'ultimoAnalisis': { $exists: true }
    }).lean();

    if (historialExistente && historialExistente.ultimoAnalisis) {
      console.log("Ya existe un análisis del día");
      // Ya existe un análisis del día
      return res.json({
        success: true,
        tieneAnalisis: true,
        sessionId: sessionId,
        analisis: historialExistente.ultimoAnalisis,
        mensajes: historialExistente.mensajes || []
      });
    } else {

      console.log("No existe análisis del día");
      // No existe análisis del día
      return res.json({
        success: true,
        tieneAnalisis: false,
        sessionId: sessionId
      });
    }

  } catch (error) {
    console.error("❌ Error al verificar análisis:", error);
    return res.status(500).json({
      success: false,
      error: "Error al verificar análisis del día"
    });
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

    const sessionId = await obtenerSesionActivaDelDia(odooUserId);

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const formattedToday = `${yyyy}-${mm}-${dd}`;

    console.time("Actividades");
    const actividadesResponse = await axios.get(
      `${API_URL_ANFETA}/actividades/assignee/${email}/del-dia`
    );
    console.timeEnd("Actividades");

    const actividadesRaw = actividadesResponse.data.data;

    if (!Array.isArray(actividadesRaw) || actividadesRaw.length === 0) {
      return res.json({
        success: true,
        answer: "No tienes actividades registradas para hoy",
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {}
      });
    }

    // Filtrar actividades válidas (excluir 00ftf y 00sec)
    const esActividadValida = (actividad) => {
      const titulo = actividad.titulo?.toLowerCase() || "";
      return !titulo.startsWith("00ftf") && actividad.status !== "00sec";
    };

    let actividadesFiltradas = actividadesRaw.filter(esActividadValida);

    if (actividadesFiltradas.length === 0) {
      return res.json({
        success: true,
        answer: "Todas tus actividades de hoy son de tipo 00ftf o 00sec (filtradas automáticamente)",
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {},
        debug: {
          totalActividades: actividadesRaw.length,
          filtradas: 0
        }
      });
    }

    // ✅ FILTRAR POR HORARIO LABORAL (09:30 - 17:00)
    const HORARIO_INICIO = 9.5; //9:30 am
    const HORARIO_FIN = 17.0;   //5:00 pm

    const actividadesEnHorarioLaboral = actividadesFiltradas.filter(actividad => {
      const horaInicioDecimal = convertirHoraADecimal(actividad.horaInicio);
      const horaFinDecimal = convertirHoraADecimal(actividad.horaFin);

      // La actividad debe empezar >= 9:30 Y terminar <= 17:00
      return horaInicioDecimal >= HORARIO_INICIO &&
        horaInicioDecimal < HORARIO_FIN &&
        horaFinDecimal <= HORARIO_FIN;
    });

    if (actividadesEnHorarioLaboral.length === 0) {
      return res.json({
        success: true,
        answer: "No tienes actividades programadas en horario laboral (09:30-17:00).",
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {},
        debug: {
          actividadesTotales: actividadesFiltradas.length,
          actividadesHorarioLaboral: 0
        }
      });
    }

    // ✅ EXTRAER SOLO LOS IDs DE ACTIVIDADES EN HORARIO LABORAL
    const actividadIdsHorarioLaboral = new Set(
      actividadesEnHorarioLaboral.map(a => a.id)
    );


    // ========== PASO 2: OBTENER REVISIONES SOLO PARA ESAS ACTIVIDADES ==========
    let todasRevisiones = { colaboradores: [] };

    console.time("Revisiones");
    try {
      const revisionesResponse = await axios.get(
        `${API_URL_ANFETA}/reportes/revisiones-por-fecha`,
        {
          params: {
            date: formattedToday,
            assignee: email
          }
        }
      );

      if (revisionesResponse.data?.success) {
        todasRevisiones = revisionesResponse.data.data || { colaboradores: [] };
      }
    } catch (error) {
      console.error("❌ Error obteniendo revisiones:", {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });
    }
    console.timeEnd("Revisiones");

    // ========== PASO 3: PROCESAR SOLO REVISIONES DE ACTIVIDADES EN HORARIO LABORAL ==========
    const revisionesPorActividad = {};
    const actividadesConRevisionesConTiempoIds = new Set();

    if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
      todasRevisiones.colaboradores.forEach(colaborador => {
        const actividades = colaborador.items?.actividades ?? [];

        actividades.forEach(actividad => {
          // 🚨 FILTRO 1: Solo procesar actividades que estén en horario laboral
          if (!actividadIdsHorarioLaboral.has(actividad.id)) {
            return;
          }

          // 🚨 FILTRO 2: Excluir 00ftf
          const tiene00ftf = actividad.titulo.toLowerCase().includes('00ftf');
          if (tiene00ftf) {
            return;
          }

          // 🚨 FILTRO 3: Verificar que tenga pendientes
          const totalPendientes = (actividad.pendientes ?? []).length;
          if (totalPendientes === 0) {
            return;
          }

          // Buscar datos completos de la actividad original
          const actividadOriginal = actividadesEnHorarioLaboral.find(a => a.id === actividad.id);
          if (!actividadOriginal) {
            return;
          }

          // Inicializar estructura
          revisionesPorActividad[actividad.id] = {
            actividad: {
              id: actividad.id,
              titulo: actividad.titulo,
              horaInicio: actividadOriginal.horaInicio || "00:00",
              horaFin: actividadOriginal.horaFin || "00:00",
              status: actividadOriginal.status || "Sin status",
              proyecto: actividadOriginal.tituloProyecto || "Sin proyecto"
            },
            pendientesConTiempo: [],
            pendientesSinTiempo: []
          };

          let tareasConTiempoEnActividad = 0;
          let tareasSinTiempoEnActividad = 0;
          let tareasNoAsignadas = 0;

          // Procesar cada pendiente
          (actividad.pendientes ?? []).forEach(p => {
            // 🚨 FILTRO 4: Verificar asignación al usuario
            const estaAsignado = p.assignees?.some(a => a.name === email);
            if (!estaAsignado) {
              tareasNoAsignadas++;
              return;
            }

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

            // 🚨 CLASIFICAR: Con tiempo vs Sin tiempo
            if (p.duracionMin && p.duracionMin > 0) {
              pendienteInfo.prioridad = p.duracionMin > 60 ? "ALTA" :
                p.duracionMin > 30 ? "MEDIA" : "BAJA";
              revisionesPorActividad[actividad.id].pendientesConTiempo.push(pendienteInfo);
              actividadesConRevisionesConTiempoIds.add(actividad.id);
              tareasConTiempoEnActividad++;
            } else {
              pendienteInfo.prioridad = "SIN TIEMPO";
              revisionesPorActividad[actividad.id].pendientesSinTiempo.push(pendienteInfo);
              tareasSinTiempoEnActividad++;
            }
          });

          // Si no tiene tareas con tiempo, eliminar la entrada
          if (tareasConTiempoEnActividad === 0) {
            delete revisionesPorActividad[actividad.id];
          }
        });
      });
    }

    // ========== PASO 4: FILTRAR ACTIVIDADES FINALES (solo las que tienen revisiones con tiempo) ==========
    const actividadesFinales = actividadesEnHorarioLaboral.filter(actividad =>
      actividadesConRevisionesConTiempoIds.has(actividad.id)
    );

    if (actividadesFinales.length === 0) {
      return res.json({
        success: true,
        answer: "No tienes actividades con tareas que tengan tiempo estimado en horario laboral (09:30-17:00).",
        sessionId: sessionId,
        actividades: [],
        revisionesPorActividad: {},
        debug: {
          actividadesHorarioLaboral: actividadesEnHorarioLaboral.length,
          actividadesConTiempo: 0
        }
      });
    }

    // ========== RESTO DEL CÓDIGO IGUAL ==========
    let totalTareasConTiempo = 0;
    let totalTareasSinTiempo = 0;
    let tareasAltaPrioridad = 0;
    let tiempoTotalEstimado = 0;

    actividadesFinales.forEach(actividad => {
      const revisiones = revisionesPorActividad[actividad.id] || { pendientesConTiempo: [], pendientesSinTiempo: [] };
      totalTareasConTiempo += revisiones.pendientesConTiempo.length;
      totalTareasSinTiempo += revisiones.pendientesSinTiempo.length;
      tareasAltaPrioridad += revisiones.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length;
      tiempoTotalEstimado += revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0);
    });

    const horasTotales = Math.floor(tiempoTotalEstimado / 60);
    const minutosTotales = tiempoTotalEstimado % 60;

    let proyectoPrincipal = "Sin proyecto específico";
    if (actividadesFinales.length > 0) {
      const actividadPrincipal = actividadesFinales[0];
      if (actividadPrincipal.tituloProyecto && actividadPrincipal.tituloProyecto !== "Sin proyecto") {
        proyectoPrincipal = actividadPrincipal.tituloProyecto;
      } else if (actividadPrincipal.titulo) {
        const tituloLimpio = actividadPrincipal.titulo
          .replace('analizador de pendientes 00act', '')
          .replace('anfeta', '')
          .replace(/00\w+/g, '')
          .trim();
        proyectoPrincipal = tituloLimpio || actividadPrincipal.titulo.substring(0, 50) + "...";
      }
    }

    const prompt = `
Eres un asistente que analiza ÚNICAMENTE actividades que:
1. Tienen revisiones CON TIEMPO estimado
2. Están en horario laboral (09:30-17:00)
3. Se han filtrado actividades 00ftf y status 00sec

Usuario: ${user.firstName} (${email})

RESUMEN DE ACTIVIDADES CON REVISIONES CON TIEMPO (09:30-17:00):
- Total actividades: ${actividadesFinales.length}
- Total tareas con tiempo: ${totalTareasConTiempo}
- Tareas de alta prioridad: ${tareasAltaPrioridad}
- Tiempo estimado total: ${horasTotales}h ${minutosTotales}m

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

      return actividadTexto;
    }).join('\n')}

PREGUNTA DEL USUARIO: "${question}"

INSTRUCCIONES ESTRICTAS DE RESPUESTA:
1. COMIENZA específicamente: "En tu horario laboral (09:30-17:00), tienes ${actividadesFinales.length} actividades con tareas que tienen tiempo estimado"
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
`.trim();

    const aiResult = await smartAICall(prompt);

    const actividadesGuardadas = await ActividadesSchema.findOne({
      odooUserId: odooUserId
    });

    const respuestaData = {
      actividades: actividadesFinales.map(a => ({
        id: a.id,
        titulo: a.titulo,
        horario: `${a.horaInicio} - ${a.horaFin}`,
        status: a.status,
        proyecto: a.tituloProyecto || "Sin proyecto",
        esHorarioLaboral: true,
        tieneRevisionesConTiempo: true
      })),
      revisionesPorActividad: actividadesFinales
        .map(actividad => {
          const revisiones = revisionesPorActividad[actividad.id];
          if (!revisiones || revisiones.pendientesConTiempo.length === 0) return null;

          const actividadGuardada = actividadesGuardadas?.actividades?.find(
            a => a.actividadId === actividad.id
          );


          return {
            actividadId: actividad.id,
            actividadTitulo: actividad.titulo,
            actividadHorario: `${actividad.horaInicio} - ${actividad.horaFin}`,
            tareasConTiempo: revisiones.pendientesConTiempo.map(tarea => {
              // Buscar descripción en la actividad guardada
              const pendienteGuardado = actividadGuardada?.pendientes?.find(
                p => p.pendienteId === tarea.id
              );

              return {
                ...tarea,
                descripcion: pendienteGuardado?.descripcion || "" // ✅ INCLUIR DESCRIPCIÓN
              };
            }),

            totalTareasConTiempo: revisiones.pendientesConTiempo.length,
            tareasAltaPrioridad: revisiones.pendientesConTiempo.filter(t => t.prioridad === "ALTA").length,
            tiempoTotal: revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0),
            tiempoFormateado: `${Math.floor(revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0) / 60)}h ${revisiones.pendientesConTiempo.reduce((sum, t) => sum + (t.duracionMin || 0), 0) % 60}m`
          };
        })
        .filter(item => item !== null)
    };

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

    const actividadesExistentes = await ActividadesSchema.findOne({
      odooUserId: odooUserId
    });

    const actividadesParaGuardar = actividadesFinales
      .map(actividad => {
        const revisiones = revisionesPorActividad[actividad.id];

        const todasLasTareas = [
          ...(revisiones.pendientesConTiempo || []),
          ...(revisiones.pendientesSinTiempo || [])
        ];

        // Buscar la actividad existente para preservar descripciones
        const actividadExistente = actividadesExistentes?.actividades?.find(
          a => a.actividadId === actividad.id
        );

        return {
          actividadId: actividad.id,
          titulo: actividad.titulo,
          horaInicio: actividad.horaInicio,
          horaFin: actividad.horaFin,
          status: actividad.status,
          fecha: new Date().toISOString().split('T')[0],
          pendientes: todasLasTareas.map(t => {
            // Buscar el pendiente existente
            const pendienteExistente = actividadExistente?.pendientes?.find(
              p => p.pendienteId === t.id
            );

            return {
              pendienteId: t.id,
              nombre: t.nombre,
              // ✅ SOLO actualizar si la nueva descripción NO está vacía
              // Si está vacía, mantener la existente
              descripcion: t.descripcion && t.descripcion.trim() !== ""
                ? t.descripcion
                : (pendienteExistente?.descripcion || ""),
              terminada: t.terminada,
              confirmada: t.confirmada,
              duracionMin: t.duracionMin,
              fechaCreacion: t.fechaCreacion,
              fechaFinTerminada: t.fechaFinTerminada
            };
          }),
          ultimaActualizacion: new Date()
        };
      });


    await ActividadesSchema.findOneAndUpdate(
      { odooUserId: odooUserId },
      {
        $set: {
          odooUserId: odooUserId,
          actividades: actividadesParaGuardar,
          ultimaSincronizacion: new Date()
        }
      },
      { upsert: true, new: true }
    );

    const sesionExistente = await HistorialBot.findOne({
      userId: odooUserId,
      sessionId: sessionId
    });

    const yaExisteAnalisisInicial = sesionExistente?.mensajes?.some(
      msg => msg.tipoMensaje === "analisis_inicial"
    );

    // Si no existe un analisis inicial, procede
    if (!yaExisteAnalisisInicial) {

      await HistorialBot.findOneAndUpdate(
        {
          userId: odooUserId,
          sessionId: sessionId
        },
        {
          $set: {
            nombreConversacion: nombreConversacionIA,
            tareasEstado: tareasEstadoArray,
            ultimoAnalisis: analisisCompleto,
            estadoConversacion: "mostrando_actividades"
          },
          $push: {
            mensajes: {
              role: "bot",
              contenido: aiResult.text,
              timestamp: new Date(),
              tipoMensaje: "analisis_inicial",
              analisis: analisisCompleto
            }
          }
        },
        {
          upsert: true,  // ✅ Crear si no existe (aunque ya debería existir)
          new: true      // ✅ Devolver el documento actualizado
        }
      );
    }

    return res.json({
      success: true,
      answer: aiResult.text,
      provider: aiResult.provider,
      sessionId: sessionId,
      proyectoPrincipal: proyectoPrincipal,
      metrics: {
        totalActividadesProgramadas: actividadesFiltradas.length,
        actividadesEnHorarioLaboral: actividadesEnHorarioLaboral.length,
        actividadesFinales: actividadesFinales.length,
        tareasConTiempo: totalTareasConTiempo,
        tareasAltaPrioridad: tareasAltaPrioridad,
        tiempoEstimadoTotal: `${horasTotales}h ${minutosTotales}m`
      },
      data: respuestaData,
      multiActividad: true,
      filtrosAplicados: {
        excluir00ftf: true,
        excluir00sec: true,
        soloHorarioLaboral: "09:30-17:00",
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

    console.error("Error completo:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno",
      error: error.message
    });
  }
}

export async function obtenerActividadesConTiempoHoy(req, res) {
  try {
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    // Buscar actividades del usuario
    const registroUsuario = await ActividadesSchema.findOne({ odooUserId }).lean();

    if (!registroUsuario || !registroUsuario.actividades) {
      return res.json({
        success: true,
        data: [],
        message: "No se encontraron actividades para hoy"
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

export const obtenerExplicacionesUsuario = async (req, res) => {
  try {
    const { odooUserId } = req.params; // O desde el token

    const registroUsuario = await ActividadesSchema.findOne({ odooUserId });

    if (!registroUsuario) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        data: []
      });
    }

    // Extraer todas las explicaciones en formato plano
    const todasExplicaciones = registroUsuario.actividades.reduce((acc, actividad) => {
      actividad.pendientes.forEach(pendiente => {
        if (pendiente.descripcion) { // Solo si tiene explicación
          acc.push({
            actividadId: actividad.actividadId,
            actividadTitulo: actividad.titulo,
            actividadFecha: actividad.fecha,
            pendienteId: pendiente.pendienteId,
            nombreTarea: pendiente.nombre,
            explicacion: pendiente.descripcion,
            terminada: pendiente.terminada,
            confirmada: pendiente.confirmada,
            duracionMin: pendiente.duracionMin,
            createdAt: pendiente.createdAt,
            updatedAt: pendiente.updatedAt,
            ultimaSincronizacion: registroUsuario.ultimaSincronizacion
          });
        }
      });
      return acc;
    }, []);

    return res.status(200).json({
      success: true,
      total: todasExplicaciones.length,
      data: todasExplicaciones,
      ultimaSincronizacion: registroUsuario.ultimaSincronizacion
    });

  } catch (error) {
    console.error("Error al obtener explicaciones:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

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

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    const sessionId = await generarSessionIdDiario(odooUserId);



    console.log(explanation)

    const prompt = `
Eres un asistente que valida si un comentario del usuario
está realmente relacionado con una tarea específica
o con algo necesario para poder avanzar en ella HOY.

CONTEXTO:
- Actividad: "${activityTitle}"
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
    const resultadoIA = aiResult?.text;

    if (!resultadoIA) {
      return res.status(500).json({ valida: false, razon: "La IA no respondió." });
    }


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

export async function validarYGuardarExplicacion(req, res) {
  try {
    const {
      actividadId,
      actividadTitulo,
      idPendiente,
      nombrePendiente,
      explicacion,
      duracionMin,
      sessionId
    } = req.body;
    console.log("req.body:", req.body);

    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const odooUserId = decoded.id;

    console.log(odooUserId)

    if (!actividadId || !idPendiente || !explicacion) {
      console.error("Datos incompletos");
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const prompt = `
Tu tarea es evaluar si la explicación del usuario corresponde, por INTENCIÓN GENERAL, al pendiente asignado.

CONTEXTO:
El usuario está explicando qué hará durante el pendiente.
ACTIVIDAD:
"${actividadTitulo}"

PENDIENTE:
"${nombrePendiente}"

EXPLICACIÓN:
"${explicacion}"

TIEMPO:
${duracionMin}

Reglas:
- La explicación proviene de VOZ A TEXTO y puede contener errores graves de pronunciación, palabras incorrectas o frases sin sentido literal.
- Debes evaluar la INTENCIÓN, no la redacción exacta.
- Acepta sinónimos, palabras mal reconocidas y referencias indirectas.
- esValida = true SOLO si la explicación está relacionada con el pendiente.
- No inventes información.

Responde ÚNICAMENTE en JSON:
{
  "esValida": boolean,
  "razon": string
}
`;

    await HistorialBot.updateOne(
      { userId: odooUserId, sessionId },
      {
        $push: {
          mensajes: {
            role: "usuario",
            contenido: explicacion,
            timestamp: new Date(),
            tipoMensaje: "explicacion_usuario"
          }
        },
        $set: { updatedAt: new Date() }
      }
    );
    const aiResult = await smartAICall(prompt);

    console.log("🤖 AI RESULT:", aiResult);

    if (!aiResult || !aiResult.text) {
      await HistorialBot.updateOne(
        { userId: odooUserId, sessionId },
        {
          $push: {
            mensajes: {
              role: "bot",
              contenido: aiEvaluation.razon,
              timestamp: new Date(),
              tipoMensaje: "validacion_fallida"
            }
          },
          $set: {
            estadoConversacion: "esperando_explicacion",
            updatedAt: new Date()
          }
        }
      );

      return res.status(503).json({
        error: "La IA no respondió correctamente",
      });
    }

    const aiEvaluation = parseAIJSONSafe(aiResult.text);

    if (!aiEvaluation.esValida) {
      return res.status(200).json({
        esValida: false,
        razon: aiEvaluation.razon,
      });
    }

    const resultado = await ActividadesSchema.findOneAndUpdate(
      {
        odooUserId: odooUserId,
        "actividades.actividadId": actividadId,
        "actividades.pendientes.pendienteId": idPendiente
      },
      {
        $set: {
          "actividades.$[act].pendientes.$[pend].descripcion": explicacion,
          "actividades.$[act].ultimaActualizacion": new Date()
        }
      },
      {
        arrayFilters: [
          { "act.actividadId": actividadId },
          { "pend.pendienteId": idPendiente }
        ],
        new: true,
        runValidators: true
      }
    );

    if (!resultado) {
      return res.status(404).json({ error: "No se pudo actualizar" });
    }

    // ✅ Log inmediato
    const actividadActualizada = resultado.actividades.find(
      a => a.actividadId === actividadId
    );

    const pendienteGuardado = actividadActualizada?.pendientes.find(
      p => p.pendienteId === idPendiente
    );

    // 🔍 VERIFICACIÓN INDEPENDIENTE DIRECTO DE LA DB
    const verificacionDB = await ActividadesSchema.findOne({
      odooUserId: odooUserId,
      "actividades.actividadId": actividadId,
    }).lean(); // .lean() devuelve objeto plano, más rápido

    const actividadDB = verificacionDB?.actividades.find(
      a => a.actividadId === actividadId
    );

    const pendienteDB = actividadDB?.pendientes.find(
      p => p.pendienteId === idPendiente
    );

    await HistorialBot.updateOne(
      { userId: odooUserId, sessionId },
      {
        $push: {
          mensajes: {
            role: "bot",
            contenido: "La explicación fue validada y guardada correctamente.",
            timestamp: new Date(),
            tipoMensaje: "validacion_exitosa"
          }
        },
        $set: {
          estadoConversacion: "explicacion_validada",
          updatedAt: new Date()
        }
      }
    );

    return res.status(200).json({
      esValida: true,
      mensaje: "Explicación validada y guardada",
    });
  } catch (error) {
    console.error("❌ validarExplicacion error:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
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

export async function obtenerTodasExplicacionesAdmin(req, res) {
  try {
    // const { token } = req.cookies;
    // if (!token) {
    //   return res.status(401).json({ success: false, message: "No autenticado" });
    // }

    // const decoded = jwt.verify(token, TOKEN_SECRET);
    // const userId = decoded.id;

    // Verificar si es admin (podrías tener un campo 'rol' en el token)
    // Por ahora, asumimos que todos pueden ver TODO

    // 1. Obtener TODOS los usuarios de ActividadesSchema
    const todosUsuarios = await ActividadesSchema.find({})
      .sort({ updatedAt: -1 })
      .lean();

    // 2. Enriquecer con info de usuario si tienes Users collection
    const usuariosEnriquecidos = await Promise.all(
      todosUsuarios.map(async (usuarioDoc) => {
        try {
          // Si tienes una colección de usuarios, busca info adicional
          const userInfo = await UserModel.findOne({ _id: usuarioDoc.odooUserId }).lean();

          return {
            ...usuarioDoc,
            userInfo: userInfo || null,
            email: userInfo?.email || "No disponible",
            nombre: userInfo?.nombre || userInfo?.username || "Usuario",
            avatar: userInfo?.avatar,
            rol: userInfo?.rol || "user"
          };
        } catch (err) {
          console.warn(`Error enriqueciendo usuario ${usuarioDoc.odooUserId}:`, err);
          return {
            ...usuarioDoc,
            userInfo: null,
            email: "Error al cargar",
            nombre: `Usuario ${usuarioDoc.odooUserId.substring(0, 8)}`,
            rol: "user"
          };
        }
      })
    );

    // 3. Calcular estadísticas generales
    const estadisticas = {
      totalUsuarios: todosUsuarios.length,
      totalActividades: todosUsuarios.reduce((sum, u) => sum + (u.actividades?.length || 0), 0),
      totalTareas: todosUsuarios.reduce((sum, u) =>
        sum + (u.actividades?.reduce((sumAct, act) => sumAct + (act.pendientes?.length || 0), 0) || 0), 0),
      totalTareasTerminadas: todosUsuarios.reduce((sum, u) =>
        sum + (u.actividades?.reduce((sumAct, act) =>
          sumAct + (act.pendientes?.filter(p => p.terminada)?.length || 0), 0) || 0), 0),
      tiempoTotalMinutos: todosUsuarios.reduce((sum, u) =>
        sum + (u.actividades?.reduce((sumAct, act) =>
          sumAct + (act.pendientes?.reduce((sumP, p) => sumP + (p.duracionMin || 0), 0) || 0), 0) || 0), 0),
    };

    // 4. Devolver respuesta estructurada
    return res.json({
      success: true,
      data: {
        usuarios: usuariosEnriquecidos,
        estadisticas,
        metadata: {
          fecha: new Date().toISOString(),
          totalRegistros: todosUsuarios.length,
          usuarioSolicitante: userId
        }
      }
    });

  } catch (error) {
    console.error("❌ Error en obtenerTodasExplicacionesAdmin:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

export async function consultarIA(req, res) {
  try {
    const { mensaje, sessionId } = sanitizeObject(req.body);
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const { id: userId } = decoded;

    if (!mensaje || mensaje.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "El mensaje es obligatorio"
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Usuario no autenticado"
      });
    }

    let finalSessionId;

    if (sessionId) {
      // Si viene sessionId desde el frontend, úsalo
      finalSessionId = sessionId;
    } else {
      // Si no viene sessionId, obtener o crear la sesión activa del día
      finalSessionId = await obtenerSesionActivaDelDia(userId);
    }


    await guardarMensajeHistorial({
      userId,
      sessionId: finalSessionId,
      role: "usuario",
      contenido: mensaje,
      tipoMensaje: "texto",
      estadoConversacion: "esperando_bot"
    });



    const contextoMemoria = await memoriaService.generarContextoIA(userId, mensaje);

    const historial = await HistorialBot.findOne(
      { userId, sessionId: finalSessionId },
      { mensajes: { $slice: -10 } }
    ).lean();

    const contextoConversacion = historial?.mensajes
      ?.filter(m => ["usuario", "bot"].includes(m.role))
      .map(m =>
        `${m.role === "usuario" ? "Usuario" : "Asistente"}: ${m.contenido}`
      )
      .join("\n") || "";


    const prompt = `Eres un asistente personal inteligente y versátil. Puedes hablar de cualquier tema de forma natural.

  CONTEXTO DEL USUARIO:
  ${contextoMemoria || 'Esta es la primera vez que hablas con este usuario.'}

  ${contextoConversacion ? `CONVERSACIÓN RECIENTE:\n${contextoConversacion}\n` : ''}

  MENSAJE ACTUAL DEL USUARIO:
  "${mensaje}"

  INSTRUCCIONES:
  1. Responde de forma natural y amigable
  2. Puedes hablar de cualquier tema: tecnología, vida cotidiana, consejos, preguntas generales, etc.
  3. No te limites a un solo tema, sé flexible
  4. Si el usuario solo dice "hola", responde con un saludo simple y natural, no asumas que necesita ayuda con algo específico
  5. Si el usuario te dice gracias, responde con un "No te preocupes" o "De nada" lo importante es que no malgastes recursos allí
  6. Si menciona información nueva sobre él, tómalo en cuenta
  7. No inventes información que no tienes
  8. Sé directo y conciso
  9. No digas que eres un modelo de lenguaje

  FORMATO DE RESPUESTA (JSON sin markdown):
  {
    "deteccion": "general" | "conversacional" | "técnico",
    "razon": "Breve razón de tu clasificación",
    "respuesta": "Tu respuesta natural y útil"
  }`;
    const aiResult = await smartAICall(prompt);

    // Limpiar respuesta
    let textoLimpio = aiResult.text.trim();

    // Remover markdown si existe
    if (textoLimpio.includes('```')) {
      textoLimpio = textoLimpio.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    const respuestaIA = parseAIJSONSafe(textoLimpio);

    // Validar respuesta
    if (!respuestaIA || !respuestaIA.respuesta) {
      console.error('❌ Respuesta de IA inválida:', aiResult.text);

      // Fallback: intentar extraer al menos el texto
      return res.status(200).json({
        success: true,
        respuesta: "Disculpa, tuve un problema al procesar tu mensaje. ¿Podrías ser más específico?"
        , sessionId: finalSessionId
      });
    }

    const mensajeCorto = mensaje.length > 150
      ? mensaje.substring(0, 150) + '...'
      : mensaje;

    const respuestaCorta = respuestaIA.respuesta.length > 150
      ? respuestaIA.respuesta.substring(0, 150) + '...'
      : respuestaIA.respuesta;

    await memoriaService.agregarHistorial(userId, 'usuario', mensajeCorto);
    await memoriaService.agregarHistorial(userId, 'ia', respuestaCorta);


    await guardarMensajeHistorial({
      userId,
      sessionId: finalSessionId,
      role: "bot",
      contenido: respuestaCorta,
      tipoMensaje: "respuesta_ia",
      estadoConversacion: "esperando_usuario"
    });

    return res.status(200).json({
      success: true,
      respuesta: respuestaIA.respuesta.trim(),
      deteccion: respuestaIA.deteccion,
      sessionId: finalSessionId
    });

  } catch (error) {
    console.error("❌ Error en consultarIA:", error);

    // Log más detallado
    if (error.response) {
      console.error('Error de API:', error.response.data);
    } else if (error.request) {
      console.error('Error de red:', error.message);
    } else {
      console.error('Error:', error.message);
    }

    return res.status(500).json({
      success: false,
      error: "Error al conectar con el servicio de IA. Por favor, intenta nuevamente."
    });
  }
}
export async function consultarIAProyecto(req, res) {
  try {
    const { mensaje, sessionId } = sanitizeObject(req.body);
    const { token } = req.cookies;
    const decoded = jwt.verify(token, TOKEN_SECRET);
    const { id: userId, email } = decoded;

    if (!mensaje || mensaje.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "El mensaje es obligatorio"
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "Usuario no autenticado"
      });
    }

    let finalSessionId;

    if (sessionId) {
      // Si viene sessionId desde el frontend, úsalo
      finalSessionId = sessionId;
    } else {
      // Si no viene sessionId, obtener o crear la sesión activa del día
      finalSessionId = await obtenerSesionActivaDelDia(userId);
    }

    await guardarMensajeHistorial({
      userId,
      sessionId: finalSessionId,
      role: "usuario",
      contenido: mensaje,
      tipoMensaje: "texto",
      estadoConversacion: "esperando_bot"
    });

    const contextoMemoria = await memoriaService.generarContextoIA(userId, mensaje);

    const registros = await ActividadesSchema.find({ odooUserId: userId }).lean();
    const actividadesResumidas = registros.flatMap(reg =>
      reg.actividades.map(act => {
        const nombresPendientes = act.pendientes
          ?.filter(p => p.nombre)
          .map(p => p.nombre) || [];

        return {
          actividad: act.titulo || "Sin título",
          pendientes: nombresPendientes,
          estado: act.estado || "sin estado"
        };
      })
    );

    const tieneActividades = actividadesResumidas.length > 0;

    const historial = await HistorialBot.findOne(
      { userId, sessionId: finalSessionId },
      { mensajes: { $slice: -10 } }
    ).lean();

    const contextoConversacion = historial?.mensajes
      ?.filter(m => ["usuario", "bot"].includes(m.role))
      .map(m =>
        `${m.role === "usuario" ? "Usuario" : "Asistente"}: ${m.contenido}`
      )
      .join("\n") || "";

    const prompt = `Eres un asistente personal inteligente. Tu trabajo es responder de forma natural, útil y relevante.

  CONTEXTO DEL USUARIO:
  ${contextoMemoria || 'Primera interacción con este usuario.'}

  ${contextoConversacion ? `CONVERSACIÓN RECIENTE:\n${contextoConversacion}\n` : ''}

  ${tieneActividades ? `ACTIVIDADES Y PENDIENTES DEL USUARIO:\n${JSON.stringify(actividadesResumidas, null, 2)}\n` : 'El usuario no tiene actividades registradas.\n'}

  MENSAJE ACTUAL DEL USUARIO:
  "${mensaje}"

  INSTRUCCIONES:
  1. Lee cuidadosamente el mensaje del usuario
  2. Si pregunta sobre sus actividades/proyectos/pendientes, usa la información de ACTIVIDADES
  3. Si pregunta algo general, responde con conocimiento general
  4. Si menciona información nueva sobre él (nombre, gustos, trabajo), tómalo en cuenta
  5. NO inventes información que no tienes
  6. NO asumas cosas del usuario que no están en el contexto
  7. Sé directo y natural en tu respuesta

  FORMATO DE RESPUESTA (JSON sin markdown):
  {
    "deteccion": "proyecto" | "general" | "conversacional",
    "razon": "Breve razón de tu clasificación",
    "respuesta": "Tu respuesta natural y útil"
  }`;

    const aiResult = await smartAICall(prompt);

    // Limpiar respuesta
    let textoLimpio = aiResult.text.trim();

    // Remover markdown si existe
    if (textoLimpio.includes('```')) {
      textoLimpio = textoLimpio.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }

    const respuestaIA = parseAIJSONSafe(textoLimpio);

    // Validar respuesta
    if (!respuestaIA || !respuestaIA.respuesta) {
      console.error('❌ Respuesta de IA inválida:', aiResult.text);

      // Fallback: intentar extraer al menos el texto
      return res.status(200).json({
        success: true,
        respuesta: "Disculpa, tuve un problema al procesar tu mensaje. ¿Podrías ser más específico?",
        sessionId: finalSessionId

      });
    }

    await memoriaService.extraerConIA(
      userId,
      email,
      mensaje,
      respuestaIA.respuesta
    );

    const mensajeCorto = mensaje.length > 150
      ? mensaje.substring(0, 150) + '...'
      : mensaje;

    const respuestaCorta = respuestaIA.respuesta.length > 150
      ? respuestaIA.respuesta.substring(0, 150) + '...'
      : respuestaIA.respuesta;

    await memoriaService.agregarHistorial(userId, 'usuario', mensajeCorto);
    await memoriaService.agregarHistorial(userId, 'ia', respuestaCorta);

    await guardarMensajeHistorial({
      userId,
      sessionId: finalSessionId,
      role: "bot",
      contenido: respuestaCorta,
      tipoMensaje: "respuesta_ia",
      estadoConversacion: "esperando_usuario"
    });

    return res.status(200).json({
      success: true,
      respuesta: respuestaIA.respuesta.trim(),
      deteccion: respuestaIA.deteccion,
      sessionId: finalSessionId

    });

  } catch (error) {
    console.error("❌ Error en consultarIA:", error);

    // Log más detallado
    if (error.response) {
      console.error('Error de API:', error.response.data);
    } else if (error.request) {
      console.error('Error de red:', error.message);
    } else {
      console.error('Error:', error.message);
    }

    return res.status(500).json({
      success: false,
      error: "Error al conectar con el servicio de IA. Por favor, intenta nuevamente."
    });
  }
}

export async function obtenerMensajesConversacion(req, res) {
  try {
    const { sessionId } = req.params;
    const { token } = req.cookies;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No autenticado"
      });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

    // Buscar el historial específico
    const historial = await HistorialBot.findOne({
      userId,
      sessionId
    }).lean();

    if (!historial) {
      return res.status(404).json({
        success: false,
        message: "Conversación no encontrada"
      });
    }

    // Buscar también las actividades asociadas
    const actividadesCache = await ActividadesSchema.findOne({
      odooUserId: userId
    }).lean();

    // Transformar mensajes al formato del frontend
    const mensajesFormateados = (historial.mensajes || []).map(msg => ({
      id: msg._id?.toString() || `${Date.now()}-${Math.random()}`,
      type: msg.role === 'usuario' ? 'user' :
        msg.role === 'bot' ? 'bot' : 'system',
      content: msg.contenido,
      timestamp: new Date(msg.timestamp),
      tipoMensaje: msg.tipoMensaje,
      analisis: msg.analisis || null
    }));

    return res.json({
      success: true,
      sessionId: historial.sessionId,
      nombreConversacion: historial.nombreConversacion,
      mensajes: mensajesFormateados,
      ultimoAnalisis: historial.ultimoAnalisis || null,
      tareasEstado: historial.tareasEstado || [],
      estadoConversacion: historial.estadoConversacion,
      actividades: actividadesCache?.actividades || [],
      meta: {
        totalMensajes: mensajesFormateados.length,
        createdAt: historial.createdAt,
        updatedAt: historial.updatedAt
      }
    });

  } catch (error) {
    console.error("❌ Error al obtener mensajes de conversación:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message
    });
  }
}

export async function obtenerOCrearSessionActual(req, res) {
  try {
    const { token } = req.cookies;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "No autenticado"
      });
    }

    const decoded = jwt.verify(token, TOKEN_SECRET);
    const userId = decoded.id;

    // ✅ Obtener o crear sesión del día (ahora crea en DB automáticamente)
    const sessionId = await obtenerSesionActivaDelDia(userId);

    // ✅ Verificar que se creó correctamente
    const historial = await HistorialBot.findOne({
      userId,
      sessionId
    }).lean();

    if (!historial) {
      console.error("❌ La sesión no se creó correctamente");
      return res.status(500).json({
        success: false,
        error: "Error al crear sesión"
      });
    }

    return res.json({
      success: true,
      sessionId,
      nombreConversacion: historial.nombreConversacion,
      estadoConversacion: historial.estadoConversacion,
      createdAt: historial.createdAt,
      existe: historial.mensajes?.length > 0
    });

  } catch (error) {
    console.error("❌ Error al obtener/crear sesión:", error);
    return res.status(500).json({
      success: false,
      error: "Error interno del servidor"
    });
  }
}