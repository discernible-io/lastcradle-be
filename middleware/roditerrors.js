// errorHandler.js

const ErrorCodes = {
  MISSING_TOKEN: 'MISSING_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_VERIFICATION_FAILED: 'TOKEN_VERIFICATION_FAILED',
  WEBHOOK_CONFIG_ERROR: 'WEBHOOK_CONFIG_ERROR',
  WEBHOOK_SEND_ERROR: 'WEBHOOK_SEND_ERROR',
  TIMESTAMP_EXPIRED: 'TIMESTAMP_EXPIRED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
 };
 
 class AppError extends Error {
  constructor(code, message, requestId) {
   super(message);
   this.code = code;
   this.requestId = requestId;
  }
 }
 
 module.exports = {
  ErrorCodes,
  AppError,
 };