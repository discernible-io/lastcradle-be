/**
 * Authentication middleware for web API
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");
const { stateManager } = require("./rodit");
const tokenService = require('../auth/tokenservice');

/**
 * Middleware for handling authentication in routes
 */
class AuthenticationMiddleware {
  constructor() {
    // Use singletons directly
    this.initialized = false;
  }

  /**
   * Initialize the AuthenticationMiddleware
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      logger.debug('AuthenticationMiddleware already initialized');
      return;
    }

    try {
      logger.debug('Initializing AuthenticationMiddleware...');
      
      // Initialize token service if needed
      if (tokenService.initialize) {
        await tokenService.initialize();
      }
      
      // Initialize any other required services
      
      this.initialized = true;
      logger.info('AuthenticationMiddleware initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize AuthenticationMiddleware', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Extract token from authorization header
   *
   * @param {string} authHeader - Authorization header
   * @returns {string|null} Extracted token or null
   */
  extractTokenFromHeader(authHeader) {
    const startTime = Date.now();
    const requestId = ulid();

    logger.debug("Extracting token from authorization header", {
      component: "TokenExtractor",
      method: "extractTokenFromHeader",
      requestId,
      hasAuthHeader: !!authHeader,
    });

    if (!authHeader) {
      logger.debug("No authorization header present", {
        component: "TokenExtractor",
        method: "extractTokenFromHeader",
        requestId,
      });
      return null;
    }

    const [bearer, token] = authHeader.split(' ');
    
    if (bearer.toLowerCase() !== 'bearer' || !token) {
      logger.debug("Invalid authorization header format", {
        component: "TokenExtractor",
        method: "extractTokenFromHeader",
        requestId,
        headerFormat: authHeader,
      });
      return null;
    }

    logger.debug("Successfully extracted token from header", {
      component: "TokenExtractor",
      method: "extractTokenFromHeader",
      requestId,
      tokenLength: token.length,
      duration: Date.now() - startTime,
    });

    return token;
  }


  /**
   * Middleware to authenticate API calls
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Next middleware function
   */
  async authenticate_apicall(req, res, next) {
    const startTime = Date.now();
    const requestId = ulid();
    const token = this.extractTokenFromHeader(req.headers.authorization);

    logger.info("API authentication started", {
      component: "AuthMiddleware",
      method: "authenticate_apicall",
      requestId,
      hasToken: !!token,
      path: req.path,
      method: req.method,
    });

    try {
      if (!token) {
        logger.warn("No token provided in request", {
          component: "AuthMiddleware",
          method: "authenticate_apicall",
          requestId,
          headers: req.headers,
        });
        return res.status(401).json({ error: "No token provided" });
      }

      // Use the token service to validate the token
      const validationResult = await tokenService.validate_jwt_token(token);

      if (!validationResult.valid) {
        logger.warn("Invalid token provided", {
          component: "AuthMiddleware",
          method: "authenticate_apicall",
          requestId,
          error: validationResult.error,
        });
        return res.status(401).json({ error: "Invalid token" });
      }

      // Attach user information to the request
      req.user = validationResult.user;
      req.token = token;

      logger.info("Authentication successful", {
        component: "AuthMiddleware",
        method: "authenticate_apicall",
        requestId,
        userId: req.user.id,
        duration: Date.now() - startTime,
      });

      next();
    } catch (error) {
      logger.error("Authentication error", {
        component: "AuthMiddleware",
        method: "authenticate_apicall",
        requestId,
        error: error.message,
        stack: error.stack,
      });
      
      return res.status(500).json({ 
        error: "Authentication failed",
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
}

// Export singleton
module.exports = new AuthenticationMiddleware();
