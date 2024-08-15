const rateLimit = require("express-rate-limit");

function ratelimitmw(maxrequests, maxrqwindow) {
  return rateLimit({
    windowMs: Math.min(maxrqwindow * 60 * 1000, 2147483647), // Cap at max 32-bit integer
    max: maxrequests,
    message: `You have exceeded your ${maxrequests} requests per ${maxrqwindow} minute(s) limit.`,
    headers: true,
  });
}

module.exports = ratelimitmw;
