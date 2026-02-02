import mongoose from "mongoose";

const memoriaSchema = new mongoose.Schema({
    odooUserId: { type: String, required: true, unique: true, index: true },
    email: String,
    memorias: {
        preferencias: { type: [String], default: [] },
        personal: { type: [String], default: [] },
        trabajo: { type: [String], default: [] },
        habilidades: { type: [String], default: [] },
        objetivos: { type: [String], default: [] },
        general: { type: [String], default: [] },
        conversaciones: { type: [String], default: [] }
    },
    historialConversaciones: [{
        ia: {
            type: String,
            enum: ["usuario", "ia"],
            required: true
        },
        resumenConversacion: String,
        timestamp: { type: Date, default: Date.now }
    }],
    relevancia: { type: Number, default: 0.5 },
    vecesAccedida: { type: Number, default: 0 },
    ultimoAcceso: { type: Date, default: Date.now },
    activa: { type: Boolean, default: true }
}, { timestamps: true });

memoriaSchema.index({ odooUserId: 1 }, { unique: true });

memoriaSchema.index({
    odooUserId: 1,
    activa: 1,
    relevancia: -1,
    ultimoAcceso: -1
});

memoriaSchema.statics.obtenerActivas = async function (odooUserId, limite = 10) {
    return this.find({
        odooUserId,
        activa: true
    })
        .sort({ relevancia: -1, ultimoAcceso: -1 })
        .limit(limite);
};

export default mongoose.model("Memoria", memoriaSchema);