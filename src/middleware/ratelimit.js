const rateLimit = require("express-rate-limit");
const logger = require("../../config/logger");
const crypto = require('crypto');
const { ulid } = require("ulid");

/**
 * Creates a rate limiting middleware with enhanced Grafana-friendly logging and metrics
 * 
 * @param {number} maxrequests - Maximum number of requests allowed within the window
 * @param {number} maxrqwindow - Window size in minutes
 * @returns {Function} Express middleware function
 */
function ratelimitmw(maxrequests, maxrqwindow) {
  // Generate a unique ID for this rate limiter instance for better tracking in Grafana
  const limiterId = crypto.randomBytes(4).toString('hex');
  const initTime = Date.now();
  
  // If either value is 0, return a pass-through middleware
  if (maxrequests === 0 || maxrqwindow === 0) {
    logger.info("Rate limiting disabled", { 
      component: "RateLimiter",
      method: "initialize",
      limiterId,
      maxRequests: maxrequests, 
      windowMinutes: maxrqwindow,
      enabled: false,
      timestamp: new Date().toISOString()
    });
    
    // Add metric for disabled rate limiters
    logger.metric && logger.metric("rate_limiter_status", 1, {
      status: "disabled",
      limiter_id: limiterId
    });
    
    return (req, res, next) => {
      // Add limiter info to the request for potential upstream logging
      req.rateLimiterInfo = {
        enabled: false,
        limiterId,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow,
        timestamp: new Date().toISOString()
      };
      
      // Track pass-through requests for visibility in Grafana
      if (logger.metric) {
        logger.metric("rate_limiter_bypass", 1, {
          limiter_id: limiterId,
          path: req.path || req.originalUrl || 'unknown',
          method: req.method || 'unknown'
        });
      }
      
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
    requestsPerSecond: (maxrequests / (windowMs / 1000)).toFixed(2),
    enabled: true,
    timestamp: new Date().toISOString()
  });
  
  // Add metric for enabled rate limiters
  logger.metric && logger.metric("rate_limiter_status", 1, {
    status: "enabled",
    limiter_id: limiterId,
    max_requests: maxrequests,
    window_minutes: maxrqwindow
  });

  return rateLimit({
    windowMs: windowMs,
    max: maxrequests,
    keyGenerator: (req) => {
      // Extract IP or custom identifier for rate limiting
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      // Add request ID if not present for tracing in Grafana
      req.requestId = req.headers['x-request-id'] || ulid();
      
      // Track request sources in Grafana
      const path = req.path || req.originalUrl || 'unknown';
      const method = req.method || 'unknown';
      
      // Log request processing with trace ID for correlation
      logger.debug("Rate limiter processing request", {
        component: "RateLimiter",
        method: "keyGenerator",
        limiterId,
        requestId: req.requestId,
        path,
        httpMethod: method,
        ip: clientIp,
        timestamp: new Date().toISOString()
      });
      
      // Track requests against rate limiter for capacity planning
      logger.metric && logger.metric("rate_limiter_requests", 1, {
        limiter_id: limiterId,
        path: path.substring(0, 50), // Truncate long paths
        method
      });
      
      return clientIp;
    },
    handler: (req, res) => {
      const requestId = req.headers['x-request-id'] || req.requestId || ulid();
      const path = req.path || req.originalUrl || 'unknown';
      const method = req.method || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      const timestamp = new Date().toISOString();
      
      // Calculate a standardized retry-after time for consistent experience
      const retryAfter = Math.ceil(windowMs / 1000);
      
      // Add retry header for clients to implement backoff
      res.setHeader('Retry-After', retryAfter);
      
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
        retryAfter,
        statusCode: 429,
        userId: req.user?.id || 'anonymous',
        timestamp
      });
      
      // Create detailed metrics for Grafana to track rate limit events
      if (logger.metric) {
        // Total rate limit events
        logger.metric("rate_limit_exceeded_total", 1, {
          limiter_id: limiterId,
          path: path.substring(0, 50), // Truncate long paths
          method
        });
        
        // Rate limit events by client IP (bucketed to prevent cardinality explosion)
        const ipBucket = clientIp.split('.').slice(0, 3).join('.') + '.0';
        logger.metric("rate_limit_exceeded_by_ip", 1, {
          limiter_id: limiterId,
          ip_bucket: ipBucket
        });
        
        // Rate limit events by path (helps identify hotspots)
        logger.metric("rate_limit_exceeded_by_path", 1, {
          limiter_id: limiterId,
          path: path.substring(0, 50) // Truncate long paths
        });
      }

      res.status(429).json({
        error: "RateLimitExceeded",
        message: "Rate limit exceeded",
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow,
        retryAfter,
        requestId
      });
    },
    skip: (req, res) => {
      // Add the request ID if not present
      req.requestId = req.headers['x-request-id'] || ulid();
      
      // Add limiter info to the request for potential upstream logging
      req.rateLimiterInfo = {
        enabled: true,
        limiterId,
        maxRequests: maxrequests,
        windowMinutes: maxrqwindow,
        timestamp: new Date().toISOString()
      };
      
      // Check if request should be excluded (e.g., health checks)
      const path = req.path || req.originalUrl || '';
      
      // Skip health check endpoints to prevent monitoring from triggering rate limits
      const isHealthCheck = path.includes('/health') || 
                           path.includes('/ping') || 
                           path.includes('/status');
                           
      if (isHealthCheck) {
        logger.debug("Skipping rate limit for health check", {
          component: "RateLimiter",
          method: "skip",
          limiterId,
          requestId: req.requestId,
          path,
          reason: "health_check"
        });
        
        // Track skipped requests
        logger.metric && logger.metric("rate_limiter_skipped", 1, {
          limiter_id: limiterId,
          reason: "health_check",
          path: path.substring(0, 50)
        });
        
        return true;
      }
      
      return false; // Don't skip any other requests
    },
    onLimitReached: (req, res, options) => {
      const requestId = req.headers['x-request-id'] || req.requestId || ulid();
      const path = req.path || req.originalUrl || 'unknown';
      const method = req.method || 'unknown';
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      const timestamp = new Date().toISOString();
      
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
        windowMinutes: maxrqwindow,
        timestamp
      });
      
      // Create a metric for clients hitting limits for the first time
      // This is different than exceeding - it marks the transition to blocked state
      logger.metric && logger.metric("rate_limit_clients_blocked", 1, {
        limiter_id: limiterId,
        path: path.substring(0, 50),
        method
      });
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false,  // Disable the `X-RateLimit-*` headers
    headers: (req, res, options) => {
      // Set custom header with limiter ID for correlation in logs
      res.setHeader('X-Rate-Limiter-ID', limiterId);
      return true; // Continue setting standard headers
    }
  });
}

module.exports = ratelimitmw;