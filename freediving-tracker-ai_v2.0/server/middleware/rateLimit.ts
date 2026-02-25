import rateLimit from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window`
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // Handled by app.set('trust proxy', 1)
  message: {
    error: "Too many requests from this IP, please try again after 15 minutes",
  },
});

export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 AI requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // Handled by app.set('trust proxy', 1)
  message: {
    error: "AI analysis limit reached for this hour. Please try again later.",
  },
});
