import { Router } from "express";
import {generarReporteDiario } from "../controllers/reporte.controller.js"

const router = Router();

router.post("/reporte-diario", generarReporteDiario);



export default router;