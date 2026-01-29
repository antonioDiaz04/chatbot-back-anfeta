import { Router } from "express";

const router = Router();
import {
  getActividadesConRevisiones,
  confirmarEstadoPendientes,
  actualizarEstadoPendientes
} from '../controllers/assistant.controller.js';

import {
  // getActividadesLocal,
  obtenerHistorialSesion,
  obtenerTodoHistorialSesion,
  // eliminarHistorialSesion,
  obtenerHistorialSidebar,
  guardarExplicaciones,
  validarExplicacion,
  obtenerActividadesConTiempoHoy
} from '../controllers/assistant.controller.js';


// Rutas de historial
router.get('/historial/sesion/:sessionId', obtenerHistorialSesion);
router.get('/historial/usuario', obtenerTodoHistorialSesion);
router.get('/historial/titulos', obtenerHistorialSidebar);


// Rutas de actividades/pendientes
router.get('/actividades/hoy/con-tiempo', obtenerActividadesConTiempoHoy);
router.put('/actividades/pendientes/actualizar', actualizarEstadoPendientes);
router.post('/validar-explicacion', validarExplicacion);
router.post('/guardar-explicaciones', guardarExplicaciones);
router.post('/actividades-con-revisiones', getActividadesConRevisiones);
router.post('/confirmarEstadoPendientes', confirmarEstadoPendientes);


// Rutas de historial
// router.delete('/historial/sesion', eliminarHistorialSesion);


export default router;