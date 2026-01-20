import mongoose from "mongoose";

const PendienteSchema = new mongoose.Schema({
    pendientId: {
        type: String,
        required: true
    },
    descripcion: {
        type: String,
        required: true
    },
    estado: {
        type: String,
        enum: ["pendiente", "completado", "cancelado"],
        default: "pendiente"
    }
});

const ActividadPendientesSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        activityId: {
            type: String,
            required: true
        },
        pendientes: {
            type: [PendienteSchema],
            default: []
        }
    },
    { timestamps: true }
);

ActividadPendientesSchema.index(
    { userId: 1, activityId: 1 },
    { unique: true }
);

export default mongoose.model(
    "ActividadPendientes",
    ActividadPendientesSchema
);