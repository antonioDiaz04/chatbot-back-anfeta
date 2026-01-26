import { Router } from "express";

const router = Router();
import { signIn, verifyToken, logout } from "../controllers/auth.controller.js";

router.post('/signIn', signIn);
router.get('/verifyToken', verifyToken);
router.post('/logout', logout);

export default router;  