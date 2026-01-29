// routes/admin.routes.js
import { Router } from "express";
import { 
  obtenerTodasExplicacionesAdmin,
} from "../controllers/admin.controller.js";

const router = Router();

// Ruta principal
router.get('/todas-explicaciones', obtenerTodasExplicacionesAdmin);

// Ruta para limpiar cache (útil para desarrollo)
// router.post('/admin/limpiar-cache', limpiarCacheUsuarios);

export default router;