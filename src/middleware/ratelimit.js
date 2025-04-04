const rateLimit = require("express-rate-limit");
const logger = require("../../config/logger");

function ratelimitmw(maxrequests, maxrqwindow) {
  // If either value is 0, return a pass-through middleware
  if (maxrequests === 0 || maxrqwindow === 0) {
    logger.info(`Rate limiting disabled: maxrequests=${maxrequests}, maxrqwindow=${maxrqwindow}`);
    return (req, res, next) => next();
  }
  
  // Important fix: ensure windowMs is at least 1ms to avoid immediate rate limiting
  const windowMs = maxrqwindow > 0 ? Math.min(maxrqwindow * 60 * 1000, 2147483647) : 1;
  
  return rateLimit({
    windowMs: windowMs,
    max: maxrequests,
    keyGenerator: (req) => req.ip,
    handler: (req, res) => {
      logger.warn(`Rate limit exceeded for ${req.ip} on ${req.path}`);
      res.status(429).json({
        error: "RateLimitExceeded",
        message: "Rate limit exceeded",
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow
      });
    },
    headers: true,
    standardHeaders: true,
    legacyHeaders: false
  });
}

module.exports = ratelimitmw;