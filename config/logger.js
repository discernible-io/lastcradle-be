const winston = require("winston");
const path = require("path");
const config = require("config");
const fs = require('fs');

const LOG_DIR = config.get("API_OPTIONS.LOG_DIR");
fs.mkdirSync(LOG_DIR, { recursive: true });

// Simple format to better handle objects and errors
const betterFormat = winston.format((info) => {
  // Handle Error objects
  if (info.error instanceof Error) {
    info.error = {
      message: info.error.message,
      stack: info.error.stack
    };
  }
  return info;
});

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    betterFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "signrodit-api" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'signroditserror.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'signroditcombined.log') 
    }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

module.exports = logger;