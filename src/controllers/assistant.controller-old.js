// import axios from 'axios';
// import { GoogleGenAI } from '@google/genai';
// import { GEMINI_API_KEY } from '../config.js';
// import { getAllUsers } from './users.controller.js';
// import { callGeminiWithRetry, isGeminiQuotaError } from '../libs/geminiRetry.js'
// import { sanitizeObject } from '../libs/sanitize.js'

// // const ai = new GoogleGenAI({
// //   apiKey: GEMINI_API_KEY,
// // });

// const urlApi = 'https://wlserver-production.up.railway.app/api';

// export async function devuelveActividades(req, res) {
//   try {
//     const { question, email } = sanitizeObject(req.body);

//     const INICIO_RANGO = horaAMinutos('09:30'); // 570
//     const FIN_RANGO = horaAMinutos('17:30');    // 1050

//     const usersData = await getAllUsers();

//     const user = usersData.items.find(
//       (u) => u.email.toLowerCase() === email.toLowerCase()
//     );

//     if (!user) {
//       return res.status(404).json({ error: 'Usuario no encontrado' });
//     }

//     // Consultar actividades del día
//     const response = await axios.get(`${urlApi}/actividades/assignee/${email}/del-dia`);

//     const actividadesRaw = response.data.data;

//     console.log("Raw activities:", actividadesRaw);

//     const actividades = Array.isArray(actividadesRaw)
//       ? actividadesRaw
//         .filter((a) => {
//           const inicio = horaAMinutos(a.horaInicio?.trim());
//           const fin = horaAMinutos(a.horaFin?.trim());

//           if (inicio === null || fin === null) return false;

//           // Descarta actividades que cruzan medianoche
//           if (fin <= inicio) return false;

//           // Solo incluye actividades que tengan al menos un minuto dentro del rango laboral
//           return fin > INICIO_RANGO && inicio < FIN_RANGO;
//         })
//         .map((a) => ({
//           id: a.id,
//           h: `${a.horaInicio}-${a.horaFin}`,
//           t: a.titulo ? a.titulo.slice(0, 60) : "Sin título",
//           s: a.status || "SIN ESTATUS",
//           p: Array.isArray(a.pendientes) ? a.pendientes.length : 0
//         }))
//       : [];


//     console.log("Filtered activities:", actividades);

//     //     const prompt = `
//     // Eres un asistente que ayuda a organizar las actividades del día.

//     // Usuario: ${user.firstName}
//     // Pregunta: "${question}"

//     // Agenda de hoy:
//     // ${actividades
//     //         .map(
//     //           a =>
//     //             `- ${a.h} | ${a.t} | ${a.s}${a.p > 0 ? ` | Pendientes: ${a.p}` : ""}`
//     //         )
//     //         .join("\n")}

//     // Responde de forma clara y directa.
//     // Si hay pendientes, menciónalos.
//     // Al final, haz una pregunta para ayudar a decidir qué actividad hacer primero.
//     // `.trim();

//     // Enviamos el prompt a Gemini con reintentos
//     // const geminiResponse = await callGeminiWithRetry(() =>
//     //   ai.models.generateContent({
//     //     model: 'gemini-3-flash-preview',
//     //     contents: prompt,
//     //   })
//     // );

//     // Respuesta final
//     res.json({
//       success: true,
//       data: actividades

//       // answer: geminiResponse.text,
//     });
//   } catch (error) {
//     console.error("Error en devuelveActividades:", error);

//     //Si se acabaron los tokens / cuota
//     // if (isGeminiQuotaError(error)) {
//     //   return res.status(429).json({
//     //     success: false,
//     //     reason: "QUOTA_EXCEEDED",
//     //     message: "El asistente está temporalmente saturado. Intenta nuevamente en unos minutos."
//     //   });
//     // }

//     return res.status(500).json({
//       success: false,
//       message: "Error interno del asistente"
//     });
//   }
// }

// export async function devuelveActReviciones(req, res) {
//   try {
//     const { email, idsAct } = sanitizeObject(req.body);


//     if (!email || !Array.isArray(idsAct)) {
//       return res.status(400).json({
//         success: false,
//         message: "Parámetros inválidos (email o idsAct)"
//       });
//     }

//     const today = new Date();
//     const yyyy = today.getFullYear();
//     const mm = String(today.getMonth() + 1).padStart(2, "0");
//     const dd = String(today.getDate()).padStart(2, "0");
//     const formattedToday = `${yyyy}-${mm}-${dd}`;

//     const response = await axios.get(
//       `${urlApi}/reportes/revisiones-por-fecha?date=${formattedToday}&colaborador=${email}`
//     );

//     if (!response.data?.success) {
//       return res.status(500).json({
//         success: false,
//         message: "Error al obtener revisiones",
//         error: response.data?.message
//       });
//     }
//     const revisiones = response.data.data;

//     // filtramos
//     const actividadesRevi = new Map();

//     revisiones.colaboradores.forEach(colaborador => {
//       (colaborador.items?.actividades ?? []).forEach(actividad => {

//         // 1️⃣ filtro por idsAct
//         if (idsAct.length && !idsAct.includes(actividad.id)) return;

//         // 2️⃣ filtro por colaborador (email)
//         const pendientesFiltrados = (actividad.pendientes ?? [])
//           .filter(p =>
//             p.assignees?.some(a => a.name === email)
//           )
//           .map(p => ({
//             id: p.id,
//             nombre: p.nombre,
//             terminada: p.terminada,
//             confirmada: p.confirmada,
//             duracionMin: p.duracionMin,
//             fechaCreacion: p.fechaCreacion,
//             fechaFinTerminada: p.fechaFinTerminada
//           }));

//         if (!pendientesFiltrados.length) return;

//         // 3️⃣ segundo filtro: evitar actividades duplicadas
//         if (!actividadesRevi.has(actividad.id)) {
//           actividadesRevi.set(actividad.id, {
//             actividades: {
//               id: actividad.id,
//               titulo: actividad.titulo
//             },
//             pendientes: pendientesFiltrados,
//             assignees: pendientesFiltrados[0]?.assignees ?? [
//               { name: email }
//             ]
//           });
//         }
//       });
//     });

//     // resultado final sin duplicados
//     const resultado = Array.from(actividadesRevi.values());

//     return res.status(200).json({
//       success: true,
//       data: resultado
//     });

//   } catch (error) {
//     // tokens agotados
//     if (isGeminiQuotaError(error)) {
//       return res.status(429).json({
//         success: false,
//         reason: "QUOTA_EXCEEDED",
//         message: "El asistente está temporalmente saturado. Intenta nuevamente en unos minutos."
//       });
//     }

//     return res.status(500).json({
//       success: false,
//       message: "Error interno del asistente"
//     });
//   }
// }

// function horaAMinutos(hora) {
//   if (!hora) return null;
//   const [h, m] = hora.split(':').map(Number);
//   return h * 60 + m;
// }
