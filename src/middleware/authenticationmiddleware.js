/**
 * Authentication middleware for web API
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");

/**
 * Middleware for handling authentication in routes
 */
class AuthenticationMiddleware {
  constructor() {
    this.initialized = false;
    this.stateManager = null;
    this.tokenService = null;
  }

  /**
   * Initialize the AuthenticationMiddleware with required dependencies
   * @param {Object} dependencies - Object containing required dependencies
   * @returns {Promise<void>}
   */
  async initialize(dependencies) {
    if (this.initialized) {
      logger.debug("AuthenticationMiddleware already initialized");
      return;
    }

    try {
      logger.debug("Initializing AuthenticationMiddleware...");

      // Set dependencies from the provided object
      this.stateManager = dependencies.stateManager;
      this.tokenService = dependencies.tokenService;

      if (!this.stateManager || !this.tokenService) {
        throw new Error(
          "Missing required dependencies for AuthenticationMiddleware"
        );
      }

      // Initialize token service if needed
      if (this.tokenService.initialize) {
        await this.tokenService.initialize(dependencies);
      }

      this.initialized = true;
      logger.info("AuthenticationMiddleware initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize AuthenticationMiddleware", {
        error: error.message,
        stack: error.stack,
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

    const [bearer, token] = authHeader.split(" ");

    if (bearer.toLowerCase() !== "bearer" || !token) {
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

      // Get own RODiT configuration first
      const config_own_rodit = await this.stateManager.getConfigOwnRodit();

      if (!config_own_rodit || !config_own_rodit.own_rodit) {
        logger.error("Server configuration not initialized", {
          component: "AuthMiddleware",
          method: "authenticate_apicall",
          requestId,
          hasConfig: !!config_own_rodit,
        });
        return res
          .status(500)
          .json({ error: "Server configuration not initialized" });
      }

      // Use the token service to validate the token WITH the own_rodit parameter
      const validationResult = await this.tokenService.validate_jwt_token_be(
        token,
        config_own_rodit.own_rodit
      );

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
        details:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }
}
// Export the class directly (will be instantiated in rodit.js)
module.exports = AuthenticationMiddleware;
