import mongoose from "mongoose";

const ReportePendienteSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        proyectoNombre: {
            type: String,
            required: true
        },

        actividadId: {
            type: String,
            required: true,
            index: true
        },

        actividadEstado: {
            type: String,
            default: "En proceso"
        },

        pendienteId: {
            type: String,
            required: true,
            index: true
        },

        pendienteNombre: {
            type: String,
            required: true
        },

        estadoFinal: {
            type: String,
            enum: ["pendiente", "cancelado"],
            required: true
        },

        motivoNoCompletado: {
            type: String,
            required: true
        },

        prioridad: {
            type: String,
            enum: ["ALTA", "MEDIA", "BAJA"],
            default: "BAJA"
        },

        duracionMin: {
            type: Number,
            default: 0
        },

        fechaReporte: {
            type: Date,
            default: Date.now,
            index: true
        }
    },
    {
        timestamps: true
    }
);
ReportePendienteSchema.index({ userId: 1, fechaReporte: -1 });
ReportePendienteSchema.index({ actividadId: 1, pendienteId: 1 });

export default mongoose.model(
    "ReportePendiente",
    ReportePendienteSchema
);