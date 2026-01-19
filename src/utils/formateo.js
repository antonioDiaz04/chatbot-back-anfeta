//limpia los todo lo que no sea un digito del telefono
export function limpiaNumero(phoneNumber) {
  let cleanedPhoneNumber = phoneNumber.replace(/^\+?\d{1,4}\s?/g, "");

  cleanedPhoneNumber = cleanedPhoneNumber.replace(/\D/g, "");
  return cleanedPhoneNumber;
}


export function formatearFecha(fechaHora) {
  let horas = fechaHora.getHours();
  const minutos = String(fechaHora.getMinutes()).padStart(2, "0"); 
  const amPm = horas >= 12 ? "PM" : "AM";

  horas = horas % 12 || 12; // Si es 0 (medianoche), se convierte a 12
  horas = String(horas).padStart(2, "0");

  // Obtener día, mes y año
  const dia = String(fechaHora.getDate()).padStart(2, "0"); 
  const mes = String(fechaHora.getMonth() + 1).padStart(2, "0"); 
  const año = String(fechaHora.getFullYear()).slice(-2);

  return `${horas}:${minutos} ${amPm}  ${dia}/${mes}/${año}`;
}