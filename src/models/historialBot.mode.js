import mongoose from "mongoose";

const MensajeSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ["usuario", "bot"],
        required: true
    },
    contenido: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const HistorialSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },
        sessionId: {
            type: String,
            required: true
        },
        mensajes: {
            type: [MensajeSchema],
            default: []
        }
    },
    { timestamps: true }
);

export default mongoose.model("HistorialBot", HistorialSchema);
