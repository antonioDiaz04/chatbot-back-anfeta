import mongoose from "mongoose";

const PendienteSchema = new mongoose.Schema({
    pendienteId: {
        type: String,
        required: true,
    },
    nombre: {
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
const ActividadesSchema = new mongoose.Schema({
    ActividadId: {
        type: String,
        required: true,
    },
    pendientes: {
        type: [PendienteSchema],
        default: []
    },
    estado: {
        type: String,
        default: "En proceso"
    },
    duracionMin: {
        type: Number,
        default: 0
    },
    prioridad: {
        type: String,
        enum: ["ALTA", "MEDIA", "BAJA"],
        default: "BAJA"
    },
    fechaCreacion: {
        type: Date,
        default: Date.now
    }
});

const ProyectosSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true
        },
        actividades: {
            type: [ActividadesSchema],
            default: []
        },
        nombre: {
            type: String,
            required: true,
            unique: true
        }
    },
    { timestamps: true }
);

ProyectosSchema.index({ userId: 1 });
ProyectosSchema.index({ userId: 1, nombre: 1 }, { unique: true });


export default mongoose.model(
    "ProyectosSchema",
    ProyectosSchema
);