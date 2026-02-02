import { Router } from "express";

const router = Router();
import {
  getActividadesConRevisiones,
  confirmarEstadoPendientes,
  actualizarEstadoPendientes,
  consultarIA,
  consultarIAProyecto
} from '../controllers/assistant.controller.js';

import {
  // getActividadesLocal,
  obtenerHistorialSesion,
  obtenerTodoHistorialSesion,
  // eliminarHistorialSesion,
  obtenerHistorialSidebar,
  guardarExplicaciones,
  validarExplicacion,
  validarYGuardarExplicacion,
  obtenerActividadesConTiempoHoy,
  obtenerTodasExplicacionesAdmin
} from '../controllers/assistant.controller.js';


// Rutas de historial
router.get('/historial/sesion/:sessionId', obtenerHistorialSesion);
router.get('/historial/usuario', obtenerTodoHistorialSesion);
router.get('/historial/titulos', obtenerHistorialSidebar);

// funcion para obtener todo los reportes de obtenerExplicacionesUsuario
router.get('/admin/todas-explicaciones', obtenerTodasExplicacionesAdmin);

// Rutas de actividades/pendientes
router.get('/actividades/hoy/con-tiempo', obtenerActividadesConTiempoHoy);
router.put('/actividades/pendientes/actualizar', actualizarEstadoPendientes);
router.post('/validar-explicacion', validarExplicacion);
router.post('/validar-guardar-explicacion', validarYGuardarExplicacion);
router.post('/guardar-explicaciones', guardarExplicaciones);
router.post('/actividades-con-revisiones', getActividadesConRevisiones);
router.post('/confirmarEstadoPendientes', confirmarEstadoPendientes);

router.post('/consultar-ia', consultarIA);
router.post('/consultar-ia-proyecto', consultarIAProyecto);



// Rutas de historial
// router.delete('/historial/sesion', eliminarHistorialSesion);


export default router;