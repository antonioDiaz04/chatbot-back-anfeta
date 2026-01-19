// src/db.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import { formatearFecha } from "../utils/formateo.js";
import { textoColorido } from "../utils/colorText.js";

dotenv.config();
const MONGO_URI = process.env.MONGO_URI;

export const connectDB = async () => {
  const modoProduction = process.env.NODE_ENV === "production";

  try {
    await mongoose.connect(MONGO_URI);

    const fechaActual = new Date();
    const fechaFormateada = formatearFecha(fechaActual);

    textoColorido(
      // [
      //   `       Base de datos conectada `,
      //   ` Hora de conexión: ${fechaFormateada} `,
      // ],
      [
        `      🚀 Base de datos conectada 💻`,
        ` Hora de conexión: ${fechaFormateada} `,
      ],
      ["rgb(60, 255, 0)", "rgb(9, 188, 9)"],
      modoProduction
    );

  } catch (error) {
    textoColorido(
      // ["🔥 ERROR: No se pudo conectar a la base de datos", "Detalles: Conexión rechazada 🛸"],
      [" ERROR: No se pudo conectar a la base de datos", "Detalles: Conexión rechazada "],
      ["rgb(255, 0, 0)", "rgb(255, 69, 0)"],
      modoProduction
    );
    console.error(error);
    process.exit(1);
  }
};
