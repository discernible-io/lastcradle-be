// errorHandler.js
const logger = require("../../config/logger");

/**
 * Standard error codes used throughout the application
 * These codes help with filtering and categorizing errors in Grafana
 */
const ErrorCodes = {
  MISSING_TOKEN: 'MISSING_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_VERIFICATION_FAILED: 'TOKEN_VERIFICATION_FAILED',
  WEBHOOK_CONFIG_ERROR: 'WEBHOOK_CONFIG_ERROR',
  WEBHOOK_SEND_ERROR: 'WEBHOOK_SEND_ERROR',
  TIMESTAMP_EXPIRED: 'TIMESTAMP_EXPIRED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  // Map error codes to HTTP status codes for consistent responses
  statusCodes: {
    MISSING_TOKEN: 401,
    INVALID_TOKEN: 401,
    TOKEN_VERIFICATION_FAILED: 401,
    WEBHOOK_CONFIG_ERROR: 500,
    WEBHOOK_SEND_ERROR: 500,
    TIMESTAMP_EXPIRED: 401,
    INVALID_SIGNATURE: 401,
    AUTHENTICATION_ERROR: 401
  }
};

/**
 * Custom application error class with enhanced Grafana compatibility
 */
class AppError extends Error {
  constructor(code, message, requestId = null) {
    super(message);
    this.code = code;
    this.requestId = requestId || require('crypto').randomUUID();
    this.timestamp = new Date().toISOString();
    this.statusCode = ErrorCodes.statusCodes[code] || 500;
    
    // Capture stack trace for better debugging in Grafana
    Error.captureStackTrace(this, this.constructor);
    
    // Log the error when it's created for immediate visibility in Grafana
    this.logError();
  }
  
  /**
   * Log the error with structured data for Grafana
   */
  logError() {
    logger.error("Application error occurred", {
      component: "ErrorHandler",
      method: this.constructor.name,
      errorCode: this.code,
      message: this.message,
      requestId: this.requestId,
      timestamp: this.timestamp,
      statusCode: this.statusCode,
      stack: this.stack
    });
  }
  
  /**
   * Create response object with standardized format
   * @returns {Object} Formatted error response
   */
  toResponse() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        requestId: this.requestId,
        timestamp: this.timestamp
      }
    };
  }
}

/**
 * Global error handling middleware for Express
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function errorMiddleware(err, req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || err.requestId || require('crypto').randomUUID();
  
  // If this is already an AppError, use it; otherwise, wrap it
  const appError = err instanceof AppError 
    ? err 
    : new AppError('INTERNAL_SERVER_ERROR', err.message || 'An unexpected error occurred', requestId);
  
  // Additional logging with request context for better Grafana querying
  logger.error("Request error", {
    component: "ErrorMiddleware",
    method: "errorMiddleware",
    path: req.path,
    method: req.method,
    statusCode: appError.statusCode,
    errorCode: appError.code,
    message: appError.message,
    requestId,
    userId: req.user?.id || 'anonymous',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    duration: Date.now() - startTime
  });
  
  // Send standardized error response
  res.status(appError.statusCode).json(appError.toResponse());
}

/**
 * Handler for uncaught exceptions and unhandled rejections
 * Logs to Grafana and gracefully terminates the process
 */
function setupGlobalErrorHandlers() {
  process.on('uncaughtException', (error) => {
    const appError = error instanceof AppError 
      ? error 
      : new AppError('UNCAUGHT_EXCEPTION', error.message || 'Uncaught exception occurred');
    
    logger.fatal("Uncaught exception", {
      component: "GlobalErrorHandler",
      method: "uncaughtException",
      errorCode: appError.code,
      message: appError.message,
      stack: appError.stack,
      requestId: appError.requestId,
      timestamp: appError.timestamp
    });
    
    // Allow logs to be written before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    const appError = reason instanceof AppError 
      ? reason 
      : new AppError('UNHANDLED_REJECTION', 
        reason?.message || 'Unhandled promise rejection occurred');
    
    logger.fatal("Unhandled rejection", {
      component: "GlobalErrorHandler",
      method: "unhandledRejection",
      errorCode: appError.code,
      message: appError.message,
      stack: appError.stack || new Error().stack,
      requestId: appError.requestId,
      timestamp: appError.timestamp
    });
  });
}

module.exports = {
  ErrorCodes,
  AppError,
  errorMiddleware,
  setupGlobalErrorHandlers
};