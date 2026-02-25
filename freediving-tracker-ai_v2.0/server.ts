import express from "express";
import { createServer as createViteServer } from "vite";
import helmet from "helmet";
import dotenv from "dotenv";
import analysisRoutes from "./server/routes/analysis.routes";
import { errorHandler } from "./server/middleware/error";
import { apiLimiter } from "./server/middleware/rateLimit";
import { logger, httpLogger } from "./server/utils/logger";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Trust proxy is required for express-rate-limit to work behind nginx
  app.set("trust proxy", 1);

  // Security & Logging
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for Vite development
  }));
  app.use(httpLogger);
  app.use(express.json());
  app.use(apiLimiter);

  // API Routes
  app.use("/api", analysisRoutes);

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  // Error handling (must be last)
  app.use(errorHandler as any);

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  logger.error("Server failed to start", err);
  process.exit(1);
});
