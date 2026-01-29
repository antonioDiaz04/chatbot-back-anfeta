import mongoose from "mongoose";

const EstadoTareaSchema = new mongoose.Schema({
    taskId: String,
    taskName: String,
    actividadTitulo: String,

    explicada: {
        type: Boolean,
        default: false
    },
    explicacion: {
        type: String,
        default: ''
    },
    validada: {
        type: Boolean,
        default: false
    },
    ultimoIntento: {
        type: Date,
        default: null
    }
}, { _id: false });


const TareaPendienteSchema = new mongoose.Schema({
    pendienteId: {
        type: String,
        default: null   // 👈 NO required
    },
    id: {
        type: String,
        default: null
    },
    nombre: String,
    descripcion: String,
    terminada: Boolean,
    confirmada: Boolean,
    duracionMin: Number,
    fechaCreacion: {
        type: Date,
        default: Date.now
    },
    fechaFinTerminada: Date,
    prioridad: String,
    diasPendiente: Number
}, { _id: false });

const RevisionActividadSchema = new mongoose.Schema({
    actividadId: String,
    actividadTitulo: String,
    totalPendientes: Number,
    pendientesAlta: Number,
    tiempoTotal: Number,
    pendientes: [TareaPendienteSchema],
    tareasConTiempo: [TareaPendienteSchema],
    tareasSinTiempo: [TareaPendienteSchema],
    totalTareas: Number,
    tareasAltaPrioridad: Number
});

const ActividadSchema = new mongoose.Schema({
    id: String,
    titulo: String,
    horario: String,
    status: String,
    proyecto: String,
    tieneRevisiones: Boolean,
    esPrincipal: Boolean
}, { _id: false });

const MetricsSchema = new mongoose.Schema({
    totalActividades: Number,
    totalPendientes: Number,
    pendientesAltaPrioridad: Number,
    tiempoEstimadoTotal: String,
    actividadesConPendientes: Number,
    tareasConTiempo: Number,
    tareasSinTiempo: Number,
    tareasAltaPrioridad: Number
}, { _id: false });

const AnalysisDataSchema = new mongoose.Schema({
    actividades: [ActividadSchema],
    revisionesPorActividad: [RevisionActividadSchema]
}, { _id: false });

const AnalisisCompletoSchema = new mongoose.Schema({
    success: Boolean,
    answer: String,
    provider: String,
    sessionId: String,
    proyectoPrincipal: String,
    metrics: MetricsSchema,
    data: AnalysisDataSchema,
    separadasPorTiempo: Boolean,
    sugerencias: [String]
}, { _id: false });

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
    },
    analisis: {
        type: AnalisisCompletoSchema,
        default: null
    },
    tipoMensaje: {
        type: String,
        enum: ["texto", "analisis_inicial", "respuesta_ia", "error", "sistema"],
        default: "texto"
    }
});

const HistorialSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true
        },
        sessionId: {
            type: String,
            required: true
        },
        nombreConversacion: {
            type: String,
            default: "Nueva conversación"
        },
        tareasEstado: {
            type: [EstadoTareaSchema],
            default: []
        },
        mensajes: {
            type: [MensajeSchema],
            default: []
        },
        ultimoAnalisis: {
            type: AnalisisCompletoSchema,
            default: null
        },
        estadoAnterior: {
            type: String,
            default: null
        },
        estadoConversacion: {
            type: String,
            enum: [
                "inicio",
                "esperando_usuario",
                "esperando_bot",
                "mostrando_actividades",
                "esperando_descripcion_pendientes",
                "esperando_confirmacion_pendientes",
                "motivo_pendiente_resagado",
                "finalizado"
            ],
            default: "inicio"
        }
    },
    { timestamps: true }
);

HistorialSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
HistorialSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("HistorialBot", HistorialSchema);