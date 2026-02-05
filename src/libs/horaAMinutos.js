// Función auxiliar
export function horaAMinutos(hora) {
  if (!hora) return null;
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

export function convertirHoraADecimal(horaString) {
  const [horas, minutos] = horaString.split(':').map(Number);
  return horas + (minutos / 60);
}