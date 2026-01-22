import { Router } from "express";

const router = Router();
import {
  devuelveActividades,
  getActividadesConRevisiones,
  devuelveActReviciones,
  guardarPendientes
} from '../controllers/assistant.controller.js';

import {
  obtenerHistorialSesion,
  obtenerHistorialesUsuario,
  eliminarHistorialSesion,

} from '../controllers/assistant.controller.js';


// Rutas de historial
router.get('/historial/sesion', obtenerHistorialSesion);
router.get('/historial/usuario', obtenerHistorialesUsuario);

// Rutas de actividades/pendientes
router.post('/actividades', devuelveActividades);
router.post('/actividades-con-revisiones', getActividadesConRevisiones);
router.post('/revisiones', devuelveActReviciones);
router.post('/guardarPendientes', guardarPendientes);

// Rutas de historial
router.delete('/historial/sesion', eliminarHistorialSesion);


export default router;