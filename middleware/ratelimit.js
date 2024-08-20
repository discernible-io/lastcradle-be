const rateLimit = require("express-rate-limit");

function ratelimitmw(maxrequests, maxrqwindow) {
  return rateLimit({
    windowMs: Math.min(maxrqwindow * 60 * 1000, 2147483647), // Cap at max 32-bit integer
    max: maxrequests,
    handler: (req, res) => {
      res.status(429).json({
        error: "RateLimitExceeded",
        message: "Rate limit exceeded",
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow
      });
    },
    headers: true,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  });
}

module.exports = ratelimitmw;