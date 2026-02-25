import { Router } from "express";
import { AnalysisController } from "../controllers/analysis.controller";
import { verifyToken } from "../middleware/auth";
import { aiLimiter } from "../middleware/rateLimit";

const router = Router();

// Protected route with rate limiting
router.post("/analyze", verifyToken as any, aiLimiter, AnalysisController.analyze as any);

export default router;
