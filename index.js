import 'dotenv/config';
import express from "express";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { textoColorido } from "./src/utils/colorText.js";
import { CORS_ORIGINS, API_VERSION, PORT } from "./src/config.js";
import { connectDB } from "./src/database/db.js";


// Importar rutas
import assistantRoutes from "./src/routes/assistant.routes.js";
import authRoutes from "./src/routes/auth.routes.js";



const app = express();

// Conectar a MongoDB al inicio
connectDB();

// CORS
app.use(cors({
  origin: CORS_ORIGINS,
  // origin: "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet());
app.use(cookieParser());

// Solo en desarrollo
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// Seguridad con headers
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "trusted-scripts.com"],
      styleSrc: ["'self'", "trusted-styles.com"],
      imgSrc: ["'self'", "trusted-images.com"],
      connectSrc: ["'self'", "api.trusted.com"],
    },
  })
);

app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

//Rutas
app.use(`/api/${API_VERSION}/assistant`, assistantRoutes);
app.use(`/api/${API_VERSION}/auth`, authRoutes);



const modoProduction = process.env.NODE_ENV === "production";
app.listen(PORT, () => {
  textoColorido(
    [`Servidor corriendo en el puerto: ${PORT} 🖥`],
    // [` Servidor corriendo en el puerto: ${PORT} `],
    ["rgb(33, 97, 235)", "rgb(46, 15, 183)"],
    modoProduction
  );
});
