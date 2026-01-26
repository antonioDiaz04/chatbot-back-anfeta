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
    duracionMin: {
        type: Number,
        default: 0,
        required: true
    },
    prioridad: {
        type: String,
        default: "BAJA"
    },
    estado: {
        type: String,
        enum: ["pendiente", "completado", "cancelado"],
        default: "pendiente"
    }
});

const ActividadesSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true
        },
        pendientes: {
            type: [PendienteSchema],
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

ActividadesSchema.index({ userId: 1 });
ActividadesSchema.index({ userId: 1, nombre: 1 }, { unique: true });


export default mongoose.model(
    "ActividadesSchema",
    ActividadesSchema
);