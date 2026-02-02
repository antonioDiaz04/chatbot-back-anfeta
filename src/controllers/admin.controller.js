// controllers/admin.controller.js - SOLO DATOS LOCALES
import ActividadesSchema from "../models/actividades.model.js";

export async function obtenerTodasExplicacionesAdmin(req, res) {
  console.log("📊 ===== OBTENIENDO TODAS LAS EXPLICACIONES (LOCALES) =====");
  
  try {
    // 1. Obtener TODAS las actividades locales
    const todasActividades = await ActividadesSchema.find({})
      .sort({ updatedAt: -1 })
      .lean();
    
    console.log(`✅ Encontradas ${todasActividades.length} actividades en MongoDB`);

    // 2. Procesar cada documento de actividades
    const usuariosProcesados = [];
    
    todasActividades.forEach((doc, index) => {
      try {
        const userId = doc.odooUserId;
        const actividades = doc.actividades || [];
        
        // Calcular estadísticas
        const todasTareas = actividades.flatMap(act => act.pendientes || []);
        
        const estadisticasUsuario = {
          totalActividades: actividades.length,
          totalTareas: todasTareas.length,
          tareasTerminadas: todasTareas.filter(p => p.terminada).length,
          tareasConfirmadas: todasTareas.filter(p => p.confirmada).length,
          tiempoTotalMinutos: todasTareas.reduce((sum, p) => sum + (p.duracionMin || 0), 0),
        };

        // Extraer proyectos únicos
        const proyectosUnicos = new Set();
        actividades.forEach(act => {
          if (act.tituloProyecto && act.tituloProyecto !== "Sin proyecto") {
            proyectosUnicos.add(act.tituloProyecto);
          }
        });

        // Crear objeto usuario
        const usuario = {
          _id: doc._id.toString(),
          odooUserId: userId,
          email: `${userId.substring(0, 8)}@local.com`,
          nombre: `Usuario ${userId.substring(0, 8)}`,
          fuente: "local",
          actividades: actividades,
          createdAt: doc.createdAt,
          ultimaSincronizacion: doc.ultimaSincronizacion,
          updatedAt: doc.updatedAt,
          __v: doc.__v || 0,
          estadisticas: estadisticasUsuario,
          proyectosUnicos: Array.from(proyectosUnicos),
          tieneActividades: actividades.length > 0
        };

        usuariosProcesados.push(usuario);
        
        console.log(`👤 Usuario ${index + 1}: ${userId} - ${actividades.length} actividades, ${todasTareas.length} tareas`);
        
      } catch (error) {
        console.error(`❌ Error procesando documento ${index}:`, error.message);
      }
    });

    // 3. Calcular estadísticas globales
    let totalActividadesGlobal = 0;
    let totalTareasGlobal = 0;
    let totalTareasTerminadasGlobal = 0;
    let totalTareasConfirmadasGlobal = 0;
    let tiempoTotalMinutosGlobal = 0;
    const todosProyectos = new Set();
    const actividadesPorFecha = {};

    usuariosProcesados.forEach(usuario => {
      totalActividadesGlobal += usuario.estadisticas.totalActividades;
      totalTareasGlobal += usuario.estadisticas.totalTareas;
      totalTareasTerminadasGlobal += usuario.estadisticas.tareasTerminadas;
      totalTareasConfirmadasGlobal += usuario.estadisticas.tareasConfirmadas;
      tiempoTotalMinutosGlobal += usuario.estadisticas.tiempoTotalMinutos;
      
      // Proyectos únicos
      usuario.proyectosUnicos.forEach(proyecto => {
        todosProyectos.add(proyecto);
      });
      
      // Actividades por fecha
      usuario.actividades.forEach(actividad => {
        const fecha = actividad.fecha || 'sin-fecha';
        actividadesPorFecha[fecha] = (actividadesPorFecha[fecha] || 0) + 1;
      });
    });

    // Ordenar actividades por fecha (más reciente primero)
    const actividadesPorFechaOrdenadas = Object.entries(actividadesPorFecha)
      .sort(([fechaA], [fechaB]) => fechaB.localeCompare(fechaA))
      .slice(0, 10);

    const estadisticasGlobales = {
      totalUsuarios: usuariosProcesados.length,
      usuariosConActividades: usuariosProcesados.filter(u => u.tieneActividades).length,
      usuariosSinActividades: usuariosProcesados.filter(u => !u.tieneActividades).length,
      totalActividades: totalActividadesGlobal,
      totalTareas: totalTareasGlobal,
      totalTareasTerminadas: totalTareasTerminadasGlobal,
      totalTareasConfirmadas: totalTareasConfirmadasGlobal,
      tiempoTotalMinutos: tiempoTotalMinutosGlobal,
      tiempoTotalFormateado: `${Math.floor(tiempoTotalMinutosGlobal / 60)}h ${tiempoTotalMinutosGlobal % 60}m`,
      proyectosUnicos: todosProyectos.size,
      actividadesPorFecha: actividadesPorFechaOrdenadas,
      porcentajeTerminadas: totalTareasGlobal > 0 
        ? Math.round((totalTareasTerminadasGlobal / totalTareasGlobal) * 100)
        : 0,
      porcentajeConActividades: usuariosProcesados.length > 0
        ? Math.round((usuariosProcesados.filter(u => u.tieneActividades).length / usuariosProcesados.length) * 100)
        : 0,
      porcentajeConfirmadas: totalTareasTerminadasGlobal > 0
        ? Math.round((totalTareasConfirmadasGlobal / totalTareasTerminadasGlobal) * 100)
        : 0
    };

    // 4. Preparar respuesta
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      metadata: {
        totalRegistros: usuariosProcesados.length,
        usuariosConDatos: usuariosProcesados.filter(u => u.tieneActividades).length,
        fuente: "MongoDB local",
        version: "1.0"
      },
      estadisticas: estadisticasGlobales,
      data: {
        usuarios: usuariosProcesados,
        resumen: {
          fechasConActividad: Object.keys(actividadesPorFecha).length,
          proyectoMasComun: Array.from(todosProyectos).slice(0, 5),
          ultimaActividad: usuariosProcesados.length > 0 
            ? usuariosProcesados[0].updatedAt 
            : null
        }
      }
    };

    console.log("========================================");
    console.log(`🎯 RESPUESTA FINAL PREPARADA:`);
    console.log(`👥 Total usuarios: ${usuariosProcesados.length}`);
    console.log(`📁 Total actividades: ${totalActividadesGlobal}`);
    console.log(`📋 Total tareas: ${totalTareasGlobal}`);
    console.log(`⏱️ Tiempo total: ${estadisticasGlobales.tiempoTotalFormateado}`);
    console.log(`📊 Porcentaje terminadas: ${estadisticasGlobales.porcentajeTerminadas}%`);
    console.log("========================================");

    return res.json(response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO en obtenerTodasExplicacionesAdmin:", error);
    
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      error: error.message,
      timestamp: new Date().toISOString(),
      sugerencia: "Verifica la conexión con MongoDB y la estructura de los datos"
    });
  }
}

// Versión alternativa: solo datos básicos
export async function obtenerExplicacionesBasicas(req, res) {
  try {
    console.log("📊 Obteniendo datos básicos...");
    
    const conteo = await ActividadesSchema.countDocuments();
    const usuarios = await ActividadesSchema.find({}, 'odooUserId actividades')
      .limit(50)
      .lean();
    
    const datosBasicos = usuarios.map(doc => ({
      odooUserId: doc.odooUserId,
      totalActividades: doc.actividades?.length || 0,
      totalTareas: doc.actividades?.reduce((sum, act) => sum + (act.pendientes?.length || 0), 0) || 0
    }));
    
    return res.json({
      success: true,
      totalUsuarios: conteo,
      datos: datosBasicos,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("Error en obtenerExplicacionesBasicas:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}