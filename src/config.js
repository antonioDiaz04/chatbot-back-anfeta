//Configuración del servidor
export const PORT = process.env.PORT || 4000;
export const API_VERSION = process.env.API_VERSION || "v1";

export const CORS_ORIGINS = process.env.CORS_ORIGINS ||  "http://localhost:4200";

//Conexion a la base de datos
export const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://usuario:"

//Credenciales de la API de Google Gemini
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY

//Credenciales de la API de Groq
export const GROQ_API_KEY_1 = process.env.GROQ_API_KEY_1; //esta es mi cuenta personal "20221076@uthh.edu.mx"
export const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2; //esta es mi cuenta personal "ech19413070170002@gmail.com"

