const winston = require('winston');
const LokiTransport = require('winston-loki');
const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, json } = format;
const path = require('path');
const config = require('config');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logDir = config.has('API_DEFAULT_OPTIONS.LOG_DIR') ? 
  config.get('API_DEFAULT_OPTIONS.LOG_DIR') : './logs';

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ' ' + JSON.stringify(metadata, null, 2);
  }
  return msg;
});

// Create logger instance
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',  // Can be overridden by LOG_LEVEL env var
  format: combine(
    timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    json()
  ),
  defaultMeta: {
    service: config.get('SERVICE_NAME') || 'servertest-api',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Console transport for development
    new transports.Console({
      format: combine(
        format.colorize(),
        timestamp(),
        consoleFormat
      )
    }),
    // File transport for all logs
    new transports.File({
      filename: path.join(logDir, 'combined.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // Error log file
    new transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ]
});

// Add Loki transport if LOKI_URL is configured
if (process.env.LOKI_URL) {
  const lokiConfig = {
    host: process.env.LOKI_URL,
    labels: { 
      job: process.env.SERVICE_NAME || 'servertest-api',
      environment: process.env.NODE_ENV || 'development',
      host: require('os').hostname()
    },
    json: true,
    format: format.json(),
    batching: true,
    interval: 5,
    timeout: 30000,
    onConnectionError: (err) => console.error('Loki connection error:', err)
  };

  // Add basic auth if provided
  if (process.env.LOKI_BASIC_AUTH) {
    lokiConfig.basicAuth = process.env.LOKI_BASIC_AUTH;
  }

  // Skip TLS verification if explicitly set (not recommended for production)
  if (process.env.LOKI_TLS_SKIP_VERIFY === 'true') {
    lokiConfig.https = { rejectUnauthorized: false };
  }

  logger.add(new LokiTransport(lokiConfig));
}

// Helper methods for context logging
logger.createLogContext = (component, method) => ({
  component,
  method,
  timestamp: new Date().toISOString(),
  pid: process.pid
});

logger.infoWithContext = (message, context, ...args) => {
  logger.info(message, { ...context, ...args });
};

logger.errorWithContext = (message, error, context, ...args) => {
  const errorInfo = error instanceof Error 
    ? { error: error.message, stack: error.stack }
    : { error: String(error) };
  logger.error(message, { ...context, ...errorInfo, ...args });
};

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  // Don't exit immediately, give time to log the error
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

module.exports = logger;
