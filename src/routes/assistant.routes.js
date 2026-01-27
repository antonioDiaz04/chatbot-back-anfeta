import { Router } from "express";

const router = Router();
import {
  devuelveActividades,
  getActividadesConRevisiones,
  devuelveActReviciones,
  // guardarPendientes,
  confirmarEstadoPendientes,
  validarExplicacion
} from '../controllers/assistant.controller.js';

import {
  // getActividadesLocal,
  obtenerHistorialSesion,
  obtenerTodoHistorialSesion,
  // eliminarHistorialSesion,
  guardarExplicaciones
} from '../controllers/assistant.controller.js';


// Rutas de historial
router.get('/historial/sesion', obtenerHistorialSesion);
router.get('/historial/usuario', obtenerTodoHistorialSesion);

// Rutas de actividades/pendientes
router.post('/actividades', devuelveActividades);
router.post('/validar-explicacion', validarExplicacion);
router.post('/guardar-explicaciones', guardarExplicaciones);
router.post('/actividades-con-revisiones', getActividadesConRevisiones);
// router.post('/actividades-local', getActividadesLocal);
router.post('/revisiones', devuelveActReviciones);
// router.post('/guardarPendientes', guardarPendientes);
router.post('/confirmarEstadoPendientes', confirmarEstadoPendientes);

// Rutas de historial
// router.delete('/historial/sesion', eliminarHistorialSesion);


export default router;