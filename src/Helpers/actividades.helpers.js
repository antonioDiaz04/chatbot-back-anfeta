export function indexById(array = []) {
  return Object.fromEntries(array.map(item => [item.id, item]));
}

export function estaEnHorarioLaboral(horaInicio) {
  const h = parseInt(horaInicio?.split(":")[0] || "0");
  return h >= 9 && h <= 17;
}

export function calcularPrioridad(min) {
  if (min > 60) return "ALTA";
  if (min > 30) return "MEDIA";
  return "BAJA";
}
