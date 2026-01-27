import mongoose from "mongoose";

const pendienteSchema = new mongoose.Schema(
  {
    pendienteId: String,
    nombre: String,
    descripcion: String,
    terminada: { type: Boolean, default: false },
    confirmada: { type: Boolean, default: false },
    duracionMin: { type: Number, default: 0 },
    fechaCreacion: Date,
    fechaFinTerminada: Date,
  },
  { _id: false }
);

const actividadSchema = new mongoose.Schema(
  {
    actividadId: { type: String, required: true },
    titulo: String,
    tituloProyecto: String,
    horaInicio: String,
    horaFin: String,
    status: String,
    fecha: String,
    pendientes: [pendienteSchema],
    ultimaActualizacion: { type: Date, default: Date.now },
  },
  { _id: false }
);

const actividadesSchema = new mongoose.Schema(
  {
    odooUserId: { type: String, required: true},
    actividades: [actividadSchema],
    ultimaSincronizacion: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Índices para búsquedas rápidas
actividadesSchema.index({ odooUserId: 1 });
actividadesSchema.index({ "actividades.actividadId": 1 });
actividadesSchema.index({ "actividades.fecha": 1 });

const ActividadesSchema = mongoose.model("Actividades", actividadesSchema);

export default ActividadesSchema;
