import axios from 'axios';
import jwt from "jsonwebtoken";
import { TOKEN_SECRET } from "../config.js";
import { getAllUsers } from './users.controller.js';
import { isGeminiQuotaError } from '../libs/geminiRetry.js'
import { sanitizeObject } from '../libs/sanitize.js'
import { smartAICall } from '../libs/aiService.js';
import { guardarMensajeHistorial } from '../libs/guardarHistorial.js';
import { generarSessionIdDiario } from '../libs/generarSessionIdDiario.js';
import { horaAMinutos } from '../libs/horaAMinutos.js';
import ProyectosSchema from "../models/actividades.model.js";
import HistorialBot from "../models/historialBot.mode.js";

const urlApi = 'https://wlserver-production.up.railway.app/api';

export async function getActividadesConRevisiones(req, res) {
    try {
        const { email, question = "¿Qué actividades y revisiones tengo hoy? ¿Qué me recomiendas priorizar?", showAll = false } = sanitizeObject(req.body);

        const { token } = req.cookies;

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No autenticado"
            });
        }

        let decoded;

        try {
            decoded = jwt.verify(token, TOKEN_SECRET);
        } catch (err) {
            console.log(err)
            return res.status(401).json({ message: "Token inválido" });
        }

        const odooUserId = decoded.id;

        const sessionId = generarSessionIdDiario(odooUserId)

        const usersData = await getAllUsers();
        const user = usersData.items.find(
            (u) => u.email.toLowerCase() === email.toLowerCase()
        );

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Obtener actividades del día para el usuario
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

        // OBTENER PROYECTO PRINCIPAL (actividad 09:30-16:30) - DINÁMICO
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
            actividadesFiltradas = actividadesRaw;
            mensajeHorario = "Mostrando todas las actividades del día";
            mostrarSoloConTiempo = false;
        } else {
            actividadesFiltradas = actividadesRaw.filter((a) => {
                return a.horaInicio === '09:30' && a.horaFin === '16:30';
            });
            mensajeHorario = "Actividades en horario 09:30-16:30";
            if (actividadesFiltradas.length === 0) {
                const respuestaSinHorario = "No tienes actividades programadas en el horario de 09:30 a 16:30";

                // Guardar respuesta del bot en historial
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
        const actividadesMap = new Map();
        actividadesFiltradas.forEach(a => {
            if (!actividadesMap.has(a.id)) {
                actividadesMap.set(a.id, a);
            }
        });
        actividadesFiltradas = Array.from(actividadesMap.values());

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
        // Procesar revisiones - SEPARAR por tiempo
        if (todasRevisiones.colaboradores && Array.isArray(todasRevisiones.colaboradores)) {
            todasRevisiones.colaboradores.forEach(colaborador => {
                (colaborador.items?.actividades ?? []).forEach(actividad => {
                    if (actividadIds.includes(actividad.id) && actividad.pendientes) {
                        (actividad.pendientes ?? []).forEach(p => {
                            const estaAsignado = p.assignees?.some(a => a.name === email);
                            if (!estaAsignado) return;

                            // ✅ VERIFICAR SI YA EXISTE ANTES DE AGREGAR
                            const yaExisteConTiempo = revisionesPorActividad[actividad.id].pendientesConTiempo.some(
                                existente => existente.id === p.id
                            );
                            const yaExisteSinTiempo = revisionesPorActividad[actividad.id].pendientesSinTiempo.some(
                                existente => existente.id === p.id
                            );

                            if (yaExisteConTiempo || yaExisteSinTiempo) return; // ✅ SALTAR SI YA EXISTE

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

        await ProyectosSchema.findOneAndUpdate(
            { userId: odooUserId },
            {
                $setOnInsert: {
                    userId: odooUserId,
                    actividades: [],
                    nombre: proyectoPrincipal
                }
            },
            { upsert: true }
        );

        // 💾 Guardar actividades (SOLO UN FOR)
        for (const actividadId of Object.keys(revisionesPorActividad)) {
            const actividad = revisionesPorActividad[actividadId];

            // ✅ Deduplicar con Map
            const pendientesMap = new Map();
            actividad.pendientesConTiempo.forEach(p => {
                if (!pendientesMap.has(p.id)) {
                    pendientesMap.set(p.id, {
                        pendienteId: p.id,
                        nombre: p.nombre || "",
                        descripcion: "",
                        estado: p.terminada ? "completado" : "pendiente",
                        duracionMin: p.duracionMin || 0,
                        prioridad: p.prioridad || "BAJA",
                        fechaCreacion: p.fechaCreacion ? new Date(p.fechaCreacion) : new Date()
                    });
                }
            });
            const pendientesUnicos = Array.from(pendientesMap.values());


            try {
                const resultado = await ProyectosSchema.updateOne(
                    {
                        userId: odooUserId,
                        "actividades.ActividadId": actividadId
                    },
                    {
                        $set: {
                            "actividades.$.pendientes": pendientesUnicos,
                            "actividades.$.estado": "En proceso"
                        }
                    }
                );

                if (resultado.matchedCount === 0) {
                    await ProyectosSchema.updateOne(
                        { userId: odooUserId },
                        {
                            $push: {
                                actividades: {
                                    ActividadId: actividadId,
                                    pendientes: pendientesUnicos,
                                    estado: "En proceso"
                                }
                            }
                        }
                    );
                }

                console.log(`✔ Actividad ${actividadId}: ${pendientesUnicos.length} pendientes únicos`);
            } catch (err) {
                console.error(`❌ Error guardando actividad ${actividadId}:`, err.message);
            }
        }
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
        // Acepta tanto userId como odooUserId para compatibilidad
        const { activityId, pendientes } = sanitizeObject(req.body);

        const { token } = req.cookies;
        const decoded = jwt.verify(token, TOKEN_SECRET);
        const odooUserId = decoded.id;

        // id del usuario
        const finalUserId = odooUserId;

        if (!finalUserId || !activityId || !Array.isArray(pendientes)) {
            console.log("error datos faltentes o los pendientes no son un array")
            return res.status(400).json({
                error: "Faltan datos requeridos"
            });
        }

        const sessionId = generarSessionIdDiario(finalUserId);

        // ✅ Guardar acción del usuario en historial
        await guardarMensajeHistorial(
            finalUserId,
            sessionId,
            "usuario",
            `Guardando ${pendientes.length} pendientes para la actividad ${activityId}`
        );

        const registro = await ProyectosSchema.create({
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

/**
 * Obtiene el historial de una sesión específica
 */

export async function obtenerHistorialSesion(req, res) {
    try {
        const { token } = req.cookies;

        const decoded = jwt.verify(token, TOKEN_SECRET);
        const userId = decoded.id;

        const sessionId = generarSessionIdDiario(userId);

        if (!sessionId) {
            return res.status(400).json({ success: false, message: "SessionId es requerido" });
        }

        // Buscamos el historial y los proyectos en paralelo
        const [historial, proyectos] = await Promise.all([
            HistorialBot.findOne({ userId, sessionId }).lean(),
            ProyectosSchema.findOne({ userId }).lean()
        ]);

        if (!historial) {
            return res.status(404).json({
                success: false,
                message: "No se encontró el historial para esta sesión"
            });
        }

        // Lógica de filtrado: solo actividades que tengan revisión (pendientes)
        if (historial.data && historial.data.revisionesPorActividad) {
            const idsConRevision = new Set(
                historial.data.revisionesPorActividad.map(r => r.actividadId)
            );

            historial.data.actividades = historial.data.actividades.filter(actividad =>
                idsConRevision.has(actividad.id)
            );
        }

        return res.json({
            success: true,
            data: historial,
            proyectos: proyectos || null
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