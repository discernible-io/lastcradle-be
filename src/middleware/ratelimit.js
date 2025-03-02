const rateLimit = require("express-rate-limit");

function ratelimitmw(maxrequests, maxrqwindow) {
    // If either value is 0, return a pass-through middleware
    if (maxrequests === 0 || maxrqwindow === 0) {
        return (req, res, next) => next();
    }

    return rateLimit({
        windowMs: Math.min(maxrqwindow * 60 * 1000, 2147483647), // Cap at max 32-bit integer
        max: maxrequests,
        // Add keyGenerator to ensure consistent IP resolution
        keyGenerator: (req) => {
            return req.ip; // This uses Express's IP resolution based on trust proxy settings
        },
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
        legacyHeaders: false  // Disable the `X-RateLimit-*` headers
    });
}

module.exports = ratelimitmw;