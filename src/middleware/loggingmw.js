const { ulid } = require("ulid");
const logger = require("../../config/logger");

/**
 * Logging middleware that captures request/response data and performance metrics
 * Optimized for Grafana visualization and monitoring
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const loggingmw = (req, res, next) => {
  // Generate request ID if not already present
  req.requestId = req.headers['x-request-id'] || ulid();
  
  // Add request ID to response headers for client correlation
  res.setHeader('x-request-id', req.requestId);
  
  const start = Date.now();
  
  // Log request start for tracking long-running requests in Grafana
  logger.debug("Request started", {
    component: "LoggingMiddleware",
    method: "requestStart",
    requestId: req.requestId,
    httpMethod: req.method,
    url: req.originalUrl,
    clientIP: req.ip,
    userAgent: req.headers['user-agent'],
    timestamp: new Date().toISOString()
  });

  // Track response size for bandwidth monitoring in Grafana
  let responseSize = 0;
  
  // Capture the original write function to track response size
  const originalWrite = res.write;
  res.write = function(chunk, encoding) {
    responseSize += chunk.length;
    return originalWrite.call(this, chunk, encoding);
  };

  // Capture the original end function
  const originalEnd = res.end;
  
  // Override the end function to log after response
  res.end = function(chunk, encoding) {
    // Update response size if chunk is provided in the end call
    if (chunk) {
      responseSize += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    }
    
    // Call the original end function
    originalEnd.call(this, chunk, encoding);
    
    // Calculate duration for performance monitoring
    const duration = Date.now() - start;
    
    // Determine request success status for metrics
    const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
    const isError = res.statusCode >= 400;
    const isServerError = res.statusCode >= 500;
    
    // Extract authentication context for security monitoring
    const userId = req.user ? req.user.id : "unauthenticated";
    const userRoles = req.user ? req.user.roles : [];
    
    // Extract operation context
    const service = req.logService || "rodit-servertestapi-api";
    const action = req.logAction || req.method;
    const resource = res.itemid || req.path;
    
    // Generate structured log for Grafana consumption
    logger.info("Request completed", {
      // Request identification for correlation
      component: "LoggingMiddleware",
      method: "requestEnd",
      requestId: req.requestId,
      eventId: ulid(),
      timestamp: new Date().toISOString(),
      
      // HTTP details for traffic analysis
      httpMethod: req.method,
      url: req.originalUrl,
      route: req.route?.path,
      queryParams: Object.keys(req.query || {}),
      clientIP: req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers.referer,
      
      // Auth context for security monitoring
      userId,
      userRoles,
      authenticated: !!req.user,
      
      // Operation context for business intelligence
      service,
      action,
      resource,
      
      // Result context for performance and error monitoring
      statusCode: res.statusCode,
      statusMessage: res.statusMessage || res.statusReason,
      responseSize,
      duration,
      isSuccess,
      isError,
      isServerError,
      
      // Performance buckets for histogram visualization
      durationBucket: getDurationBucket(duration)
    });
    
    // Emit metrics for Grafana dashboards
    emitMetrics(req, res, duration, responseSize);
  };
  
  // Continue to the next middleware
  next();
};

/**
 * Get appropriate duration bucket for histogram visualization in Grafana
 * 
 * @param {number} duration - Request duration in milliseconds
 * @returns {string} Duration bucket label
 */
function getDurationBucket(duration) {
  if (duration < 10) return "0-10ms";
  if (duration < 50) return "10-50ms";
  if (duration < 100) return "50-100ms";
  if (duration < 300) return "100-300ms";
  if (duration < 500) return "300-500ms";
  if (duration < 1000) return "500-1000ms";
  if (duration < 2000) return "1-2s";
  if (duration < 5000) return "2-5s";
  if (duration < 10000) return "5-10s";
  return "10s+";
}

/**
 * Emit metrics for Grafana dashboard visualization
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {number} duration - Request duration in milliseconds
 * @param {number} responseSize - Response size in bytes
 */
function emitMetrics(req, res, duration, responseSize) {
  const baseLabels = {
    method: req.method,
    path: req.route?.path || 'unknown',
    status: res.statusCode,
    service: req.logService || "rodit-servertestapi-api"
  };
  
  // Request count metric
  logger.metric("http_requests_total", 1, baseLabels);
  
  // Request duration metric
  logger.metric("http_request_duration_milliseconds", duration, baseLabels);
  
  // Response size metric
  logger.metric("http_response_size_bytes", responseSize, baseLabels);
  
  // Error counter if applicable
  if (res.statusCode >= 400) {
    logger.metric("http_request_errors_total", 1, {
      ...baseLabels,
      error_type: res.statusCode >= 500 ? 'server_error' : 'client_error'
    });
  }
}

module.exports = loggingmw;