const rateLimit = require("express-rate-limit");
const logger = require("../../config/logger");
const crypto = require('crypto');

/**
 * Creates a rate limiting middleware with Grafana-friendly logging
 * 
 * @param {number} maxrequests - Maximum number of requests allowed within the window
 * @param {number} maxrqwindow - Window size in minutes
 * @returns {Function} Express middleware function
 */
function ratelimitmw(maxrequests, maxrqwindow) {
  // Generate a unique ID for this rate limiter instance for better tracking in Grafana
  const limiterId = crypto.randomBytes(4).toString('hex');
  
  // If either value is 0, return a pass-through middleware
  if (maxrequests === 0 || maxrqwindow === 0) {
    logger.info("Rate limiting disabled", { 
      component: "RateLimiter",
      method: "initialize",
      limiterId,
      maxRequests: maxrequests, 
      windowMinutes: maxrqwindow,
      enabled: false
    });
    
    return (req, res, next) => {
      // Add limiter info to the request for potential upstream logging
      req.rateLimiterInfo = {
        enabled: false,
        limiterId,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow
      };
      next();
    };
  }

  // Important fix: ensure windowMs is at least 1ms to avoid immediate rate limiting
  // Also handle potential integer overflow by capping at max safe integer
  const windowMs = maxrqwindow > 0 ? 
    Math.min(maxrqwindow * 60 * 1000, Number.MAX_SAFE_INTEGER) : 1;
  
  logger.info("Rate limiting enabled", { 
    component: "RateLimiter",
    method: "initialize",
    limiterId,
    maxRequests: maxrequests, 
    windowMinutes: maxrqwindow,
    windowMs,
    enabled: true
  });

  return rateLimit({
    windowMs: windowMs,
    max: maxrequests,
    keyGenerator: (req) => {
      // Extract IP or custom identifier for rate limiting
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      // Add request ID if not present for tracing in Grafana
      req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
      return clientIp;
    },
    handler: (req, res) => {
      const requestId = req.headers['x-request-id'] || req.requestId || crypto.randomUUID();
      const path = req.path || req.originalUrl || 'unknown';
      const method = req.method || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      
      // Log with rich context for Grafana querying and visualization
      logger.warn("Rate limit exceeded", {
        component: "RateLimiter", 
        method: "handler",
        limiterId,
        requestId,
        path,
        httpMethod: method,
        ip: clientIp,
        userAgent,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow,
        statusCode: 429,
        userId: req.user?.id || 'anonymous'
      });
      
      // Create metric for Grafana to track rate limit events
      logger.metric("rate_limit_exceeded", 1, {
        limiterId,
        path,
        method,
        ip: clientIp
      });

      res.status(429).json({
        error: "RateLimitExceeded",
        message: "Rate limit exceeded",
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow,
        requestId
      });
    },
    skip: (req, res) => {
      // Optional skip function - you can customize this to exclude certain routes
      // Add the request ID if not present
      req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
      
      // Add limiter info to the request for potential upstream logging
      req.rateLimiterInfo = {
        enabled: true,
        limiterId,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow
      };
      
      return false; // Don't skip any requests by default
    },
    onLimitReached: (req, res, options) => {
      const requestId = req.headers['x-request-id'] || req.requestId || crypto.randomUUID();
      const path = req.path || req.originalUrl || 'unknown';
      const method = req.method || 'unknown';
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      
      // Log when a client first exceeds their rate limit
      logger.warn("Client reached rate limit", {
        component: "RateLimiter",
        method: "onLimitReached",
        limiterId,
        requestId,
        path,
        httpMethod: method,
        ip: clientIp,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow
      });
    },
    headers: true,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false   // Disable the `X-RateLimit-*` headers
  });
}

module.exports = ratelimitmw;