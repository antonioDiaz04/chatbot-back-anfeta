

// export function generarSessionIdDiario( idUser) {
//   const fecha = new Date().toISOString().split('T')[0]; // "2026-01-20"
//   return `Act_${idUser}_${fecha}`.replace(/[^a-zA-Z0-9_]/g, '_');
// }

import ActividadesSchema from "../models/actividades.model.js";

export function generarSessionBase(idUser) {
  const fecha = new Date();
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const dd = String(fecha.getDate()).padStart(2, "0");

  return `Act_${idUser}_${yyyy}_${mm}_${dd}`;
}

export async function generarSessionIdDiario(idUser) {
  const base = generarSessionBase(idUser);

  // Buscar la última sesión del día
  const ultima = await ActividadesSchema.findOne({
    sessionId: { $regex: `^${base}` }
  })
    .sort({ createdAt: -1 })
    .lean();

  // Si no existe ninguna → esta es la primera (sin número)
  if (!ultima) {
    return base;
  }

  const partes = ultima.sessionId.split("_");
  const ultimoValor = Number(partes[partes.length - 1]);

  // Caso: la última NO tenía número → ahora toca _2
  if (isNaN(ultimoValor)) {
    return `${base}_2`;
  }

  // Caso normal: incrementar
  return `${base}_${ultimoValor + 1}`;
}


export async function esPrimeraSesionDelDia(idUser) {
  const fecha = new Date();
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const dd = String(fecha.getDate()).padStart(2, "0");

  const base = `Act_${idUser}_${yyyy}_${mm}_${dd}`;

  const existe = await ActividadesSchema.exists({
    sessionId: { $regex: `^${base}` }
  });

  return !existe; // true = primera del día
}
