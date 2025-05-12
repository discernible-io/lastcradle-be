/**
 * Authentication middleware for web API
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");
const StateManager = require("../middleware/rodit");
const TokenService = require('../auth/tokenservice');

/**
 * Middleware for handling authentication in routes
 */
class AuthenticationMiddleware {
  constructor(tokenService, stateManager) {
    this.tokenService = tokenService;
    this.stateManager = stateManager;
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

    const parts = authHeader.split(" ");

    // Check for proper Bearer token format
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      logger.warn("Invalid authorization header format", {
        component: "TokenExtractor",
        method: "extractTokenFromHeader",
        requestId,
        duration: Date.now() - startTime,
        headerFormat: authHeader.substring(0, 20) + "...", // Log a safe portion
      });

      // Emit metrics for Grafana dashboards
      logger.metric("token_extraction_errors_total", 1, {
        component: "TokenExtractor",
        reason: "INVALID_FORMAT",
      });

      return null;
    }

    const token = parts[1];

    // Additional validation: check for empty token
    if (!token || token.trim() === "") {
      logger.warn("Empty token in authorization header", {
        component: "TokenExtractor",
        method: "extractTokenFromHeader",
        requestId,
        duration: Date.now() - startTime,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("token_extraction_errors_total", 1, {
        component: "TokenExtractor",
        reason: "EMPTY_TOKEN",
      });

      return null;
    }

    const duration = Date.now() - startTime;
    logger.debug("Token successfully extracted", {
      component: "TokenExtractor",
      method: "extractTokenFromHeader",
      requestId,
      duration,
      format: parts[0],
      tokenLength: token.length,
    });

    return token;
  }

  /**
   * Handle token verification errors
   *
   * @param {Error} error - Token verification error
   * @param {Object} res - Express response object
   * @param {string} requestId - Request ID for tracking
   * @returns {Object} Error response
   */
  handleTokenError(error, res, requestId) {
    const startTime = Date.now();

    logger.error("Token error occurred", {
      component: "TokenErrorHandler",
      method: "handleTokenError",
      requestId,
      errorCode: error.code || "UNKNOWN_ERROR",
      errorMessage: error.message,
      stack: error.stack,
    });

    // Emit metrics for Grafana dashboards
    logger.metric("token_errors_total", 1, {
      component: "TokenErrorHandler",
      errorCode: error.code || "UNKNOWN_ERROR",
    });

    if (error.code === "ERR_JWT_EXPIRED") {
      const duration = Date.now() - startTime;

      logger.debug("Responding with token expired error", {
        component: "TokenErrorHandler",
        method: "handleTokenError",
        requestId,
        duration,
        statusCode: 401,
      });

      return res.status(401).json({
        error: {
          code: "TOKEN_EXPIRED",
          message: "Token has expired",
          requestId,
        },
      });
    } else if (error.code === "ERR_JWT_INVALID") {
      const duration = Date.now() - startTime;

      logger.debug("Responding with invalid token error", {
        component: "TokenErrorHandler",
        method: "handleTokenError",
        requestId,
        duration,
        statusCode: 401,
      });

      return res.status(401).json({
        error: {
          code: "INVALID_TOKEN",
          message: "Invalid token",
          requestId,
        },
      });
    } else if (error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      const duration = Date.now() - startTime;

      logger.debug("Responding with signature verification failed error", {
        component: "TokenErrorHandler",
        method: "handleTokenError",
        requestId,
        duration,
        statusCode: 401,
      });

      return res.status(401).json({
        error: {
          code: "INVALID_SIGNATURE",
          message: "Token signature verification failed",
          requestId,
        },
      });
    } else if (error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const duration = Date.now() - startTime;

      logger.debug("Responding with claim validation failed error", {
        component: "TokenErrorHandler",
        method: "handleTokenError",
        requestId,
        duration,
        statusCode: 401,
        claim: error.claim,
      });

      return res.status(401).json({
        error: {
          code: "INVALID_CLAIM",
          message: `Token claim validation failed: ${error.claim}`,
          requestId,
        },
      });
    }

    // Default error handling for unspecified errors
    const duration = Date.now() - startTime;

    logger.debug("Responding with generic token verification error", {
      component: "TokenErrorHandler",
      method: "handleTokenError",
      requestId,
      duration,
      statusCode: 403,
    });

    return res.status(403).json({
      error: {
        code: "TOKEN_VERIFICATION_FAILED",
        message: "Token verification failed",
        requestId,
      },
    });
  }

  /**
   * Middleware to authenticate API calls
   *
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Function} next - Express next function
   */
  async authenticate_apicall(req, res, next) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting API call authentication", {
      component: "AuthenticationMiddleware",
      method: "authenticate_apicall",
      requestId,
      path: req.path,
      method: req.method,
    });

    try {
      // Extract token using the dedicated token extractor
      const token = this.extractTokenFromHeader(req.headers.authorization);

      if (!token) {
        logger.warn("API authentication failed - no token provided", {
          component: "AuthenticationMiddleware",
          method: "authenticate_apicall",
          requestId,
          path: req.path,
        });

        return res.status(401).json({
          error: {
            code: "MISSING_TOKEN",
            message: "No token provided",
            requestId,
          },
        });
      }

      // Get the peer public key from state manager
      const base64PublicKey = this.stateManager.getPeerBase64urlJwkPublicKey();

      if (!base64PublicKey) {
        logger.error("No peer public key available", {
          component: "AuthenticationMiddleware",
          method: "authenticate_apicall",
          requestId,
        });

        return res.status(500).json({
          error: {
            code: "KEY_ERROR",
            message: "Error retrieving authentication key",
            requestId,
          },
        });
      }

      // Convert to JWK
      const jwk_public_key = await this.tokenService.base64url2jwk_public_key(
        base64PublicKey
      );

      try {
        // Verify the token
        const verificationResult = await this.tokenService.verifyToken(
          token,
          jwk_public_key,
          req.headers["x-timestamp"],
          requestId
        );

        const payload = verificationResult.payload;
        let newToken = verificationResult.newToken;

        // Check if session is active - disabled for now but may be re-enabled
        /*
        if (payload.session_id) {
          const isSessionActive = sessionManager.isSessionActive(payload.session_id);
          
          if (!isSessionActive) {
            logger.warn("Authentication failed - Session inactive or closed", {
              component: "AuthenticationMiddleware",
              method: "authenticate_apicall",
              requestId,
              sessionId: payload.session_id,
              tokenJti: payload.jti
            });
            
            return res.status(401).json({
              error: {
                code: "INVALID_SESSION",
                message: "Session inactive or closed",
                requestId,
              },
            });
          }
          
          // Update session last accessed time
          sessionManager.updateSession(payload.session_id, {
            lastAccessedAt: Math.floor(Date.now() / 1000)
          });
        }*/

        // Check if token needs proactive renewal
        if (!newToken) {
          try {
            logger.debug("Checking for proactive token renewal", {
              component: "AuthenticationMiddleware",
              method: "authenticate_apicall",
              requestId,
              tokenId: payload.jti || "unknown",
            });

            // Call token renewal function
            const renewalResult = await this.tokenService.checkAndRenewToken(
              payload,
              Math.floor(Date.now() / 1000),
              requestId
            );

            if (renewalResult.newToken) {
              newToken = renewalResult.newToken;
              logger.info("Token proactively renewed", {
                component: "AuthenticationMiddleware",
                method: "authenticate_apicall",
                requestId,
                renewalInfo: renewalResult.logInfo,
              });

              // Metrics for successful proactive renewal
              logger.metric("token_proactive_renewals_total", 1, {
                component: "AuthenticationMiddleware",
                path: req.path,
              });
            }
          } catch (renewalError) {
            // Non-fatal: log but continue processing
            logger.error("Proactive token renewal failed", {
              component: "AuthenticationMiddleware",
              method: "authenticate_apicall",
              requestId,
              error: renewalError.message,
            });

            // Metrics for failed renewal
            logger.metric("token_renewal_errors_total", 1, {
              component: "AuthenticationMiddleware",
              error: renewalError.constructor.name,
            });
          }
        }

        // Include new token in response if available
        if (newToken) {
          res.setHeader("New-Token", newToken);

          // Also set cookie as a fallback method
          res.cookie("auth-token", newToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
            sameSite: "strict",
          });

          logger.debug("New token set in response headers", {
            component: "AuthenticationMiddleware",
            method: "authenticate_apicall",
            requestId,
          });
        }

        // Attach user data to request
        req.user = payload;

        const duration = Date.now() - startTime;
        logger.debug("Authentication successful", {
          component: "AuthenticationMiddleware",
          method: "authenticate_apicall",
          requestId,
          duration,
          newTokenProvided: !!newToken,
        });

        // Metrics for successful auth
        logger.metric("api_authentication_duration_ms", duration, {
          component: "AuthenticationMiddleware",
          success: true,
          renewal: !!newToken,
        });

        next();
      } catch (verifyError) {
        // Use the specialized error handler for token errors
        return this.handleTokenError(verifyError, res, requestId);
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Authentication middleware error", {
        component: "AuthenticationMiddleware",
        method: "authenticate_apicall",
        requestId,
        duration,
        error: error.message,
        stack: error.stack,
      });

      // Metrics for auth errors
      logger.metric("api_authentication_errors_total", 1, {
        component: "AuthenticationMiddleware",
        error: error.constructor.name,
      });

      return res.status(500).json({
        error: {
          code: "AUTH_ERROR",
          message: "Authentication process failed",
          requestId,
        },
      });
    }
  }
}

module.exports = AuthenticationMiddleware;
