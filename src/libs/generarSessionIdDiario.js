export function generarSessionIdDiario( idUser) {
  const fecha = new Date().toISOString().split('T')[0]; // "2026-01-20"
  return `Act_${idUser}_${fecha}`.replace(/[^a-zA-Z0-9_]/g, '_');
}