import { Router } from "express";

const router = Router();
import { 
  devuelveActividades, 
  getActividadesConRevisiones,
  devuelveActReviciones 
} from '../controllers/assistant.controller.js';

router.post('/actividades', devuelveActividades);
router.post('/actividades-con-revisiones', getActividadesConRevisiones); 
router.post('/revisiones', devuelveActReviciones);


export default router;