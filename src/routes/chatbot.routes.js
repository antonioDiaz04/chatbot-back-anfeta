// routes/chatbot.routes.js
import express from "express"
import { obtenerEstadoDiarioChatbot } from "../controllers/chatbot.controller.js"
import { validarJWT } from "../middlewares/validar-jwt.js"

const router = express.Router()

router.get(
  "/estado-diario",
  validarJWT,
  obtenerEstadoDiarioChatbot
)

export default router
