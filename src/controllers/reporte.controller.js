import ActividadesSchema from "../models/actividades.model.js";
import ReportePendiente from "../models/reporte.model.js";

export async function generarReporteDiario(req, res) {
    try {

        // Fecha normalizada del día
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        // Borrar reporte de hoy (si existe)
        await ReportePendiente.deleteMany({
            fechaReporte: {
                $gte: hoy,
                $lt: new Date(hoy.getTime() + 24 * 60 * 60 * 1000)
            }
        });

        // Obtener TODOS los proyectos
        const proyectos = await ActividadesSchema.find({});

        const reportes = [];

        // Generar snapshot diario
        for (const proyecto of proyectos) {
            for (const actividad of proyecto.actividades) {
                for (const pendiente of actividad.pendientes) {

                    if (
                        pendiente.estado !== "completado" &&
                        pendiente.motivoNoCompletado
                    ) {
                        reportes.push({
                            userId: proyecto.userId,
                            proyectoNombre: proyecto.nombre,
                            actividadId: actividad.ActividadId,
                            pendienteId: pendiente.pendienteId,
                            pendienteNombre: pendiente.nombre,
                            estadoFinal: pendiente.estado,
                            motivoNoCompletado: pendiente.motivoNoCompletado,
                            prioridad: actividad.prioridad,
                            duracionMin: actividad.duracionMin,
                            fechaReporte: hoy
                        });
                    }
                }
            }
        }

        // Guardar reporte diario
        if (reportes.length) {
            await ReportePendiente.insertMany(reportes);
        }

        res.json({
            success: true,
            fecha: hoy.toISOString().split("T")[0],
            totalReportes: reportes.length
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: "Error al generar reporte diario"
        });
    }
}