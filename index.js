import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { textoColorido } from "./src/utils/colorText.js";
import { CORS_ORIGINS, API_VERSION, PORT } from "./src/config.js";
import { connectDB } from "./src/database/db.js";

// Rutas
import adminRouter from "./src/routes/admin.routes.js";
import assistantRoutes from "./src/routes/assistant.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import reportesRoutes from "./src/routes/reportes.routes.js";

const modoProduction = process.env.NODE_ENV === "production";

const app = express();

// DB
connectDB();

// CORS (IMPORTANTE)
app.use(
  cors({
    origin: CORS_ORIGINS, // EJ: https://tu-frontend.onrender.com
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

// Middlewares base
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Helmet (SIN CSP custom)
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// Logs solo en dev
if (!modoProduction) {
  app.use(morgan("dev"));
}

// Headers extra (seguros)
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Rutas
app.use(`/api/${API_VERSION}/assistant`, assistantRoutes);
app.use(`/api/${API_VERSION}/admin`, adminRouter);
app.use(`/api/${API_VERSION}/auth`, authRoutes);
app.use(`/api/${API_VERSION}/reportes`, reportesRoutes);



// Server
app.listen(PORT, () => {
  textoColorido(
    [`Servidor corriendo en el puerto: ${PORT} 🖥`],
    ["rgb(33, 97, 235)", "rgb(46, 15, 183)"],
    modoProduction
  );
});
