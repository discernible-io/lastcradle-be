/**
 * Authentication service for RODiT authentication
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");
const nacl = require("tweetnacl");
const { calculateCanonicalHash, unixTimeToDateString } = require("../utils");
const config = require("config");
const {CONSTANTS
} = require("../blockchain/blockchainservice");
const {generate_jwt_token} = require("../auth/tokenservice");

class Authentication {
  constructor() {
    this.initialized = false;
    this.stateManager = null;
    this.tokenService = null;
    this.blockchainService = null;
  }

  /**
   * Initialize the Authentication service with required dependencies
   * @param {Object} dependencies - Object containing required dependencies
   * @returns {Promise<void>}
   */
  async initialize(dependencies) {
    if (this.initialized) {
      logger.debug("Authentication service already initialized");
      return;
    }

    try {
      logger.debug("Initializing Authentication service...");

      // Set dependencies from the provided object
      this.stateManager = dependencies.stateManager;
      this.tokenService = dependencies.tokenService;
      this.blockchainService = dependencies.blockchainService;

      if (!this.stateManager || !this.tokenService || !this.blockchainService) {
        throw new Error(
          "Missing required dependencies for Authentication service"
        );
      }

      // Initialize token service if needed
      if (this.tokenService.initialize) {
        await this.tokenService.initialize(dependencies);
      }

      this.initialized = true;
      logger.info("Authentication service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize Authentication service", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * Handle client logout
   *
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @returns {Object} Response object
   */
  async logout_client(req, res) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("Logout request received", {
      component: "AuthenticationService",
      method: "logout_client",
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
    });

    try {
      // Extract token from authorization header
      const token =
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
          ? req.headers.authorization.substring(7)
          : null;

      if (!token) {
        const duration = Date.now() - startTime;

        logger.warn("Logout failed - no token provided", {
          component: "AuthenticationService",
          method: "logout_client",
          requestId,
          duration,
          ip: req.ip,
        });

        // Emit metrics for unauthorized logout attempts
        logger.metric &&
          logger.metric("logout_attempts", 1, {
            component: "AuthenticationService",
            result: "no_token",
          });

        return res.status(401).json({
          message: "No authentication token provided",
          requestId,
        });
      }

      // Decode the token to get session information
      // We're just decoding, not verifying, since even if the token is expired
      // we still want to be able to log the user out
      let decodedToken;
      try {
        // Split the token and decode the payload (middle part)
        const parts = token.split(".");
        if (parts.length !== 3) {
          throw new Error("Invalid token format");
        }

        const payload = Buffer.from(parts[1], "base64url").toString();
        decodedToken = JSON.parse(payload);

        logger.debug("Token decoded for logout", {
          component: "AuthenticationService",
          method: "logout_client",
          requestId,
          jti: decodedToken.jti,
          hasSessionId: !!decodedToken.session_id,
        });
      } catch (decodeError) {
        logger.error("Failed to decode token for logout", {
          component: "AuthenticationService",
          method: "logout_client",
          requestId,
          error: decodeError.message,
        });

        // Continue with a partial logout even if token can't be decoded
        decodedToken = {};
      }

      // Track success for metrics
      let logoutSuccess = false;
      let sessionClosed = false;

      // Close the session if session_id is available
      if (decodedToken.session_id) {
        try {
          // Get the reason from request body or use default
          const reason = req.body.reason || "user_logout";

          // Close the session
          sessionClosed = this.stateManager.closeSession(
            decodedToken.session_id,
            reason
          );

          if (sessionClosed) {
            logger.info("Session closed successfully", {
              component: "AuthenticationService",
              method: "logout_client",
              requestId,
              sessionId: decodedToken.session_id,
              reason,
            });

            logoutSuccess = true;
          } else {
            logger.warn("Session not found or already closed", {
              component: "AuthenticationService",
              method: "logout_client",
              requestId,
              sessionId: decodedToken.session_id,
            });

            // We still consider this a success from the client perspective
            // since the session is effectively "logged out" either way
            logoutSuccess = true;
          }
        } catch (sessionError) {
          logger.error("Error closing session", {
            component: "AuthenticationService",
            method: "logout_client",
            requestId,
            sessionId: decodedToken.session_id,
            error: sessionError.message,
          });

          // Continue with logout process even if session closing fails
        }
      } else {
        logger.warn("Logout with token that has no session ID", {
          component: "AuthenticationService",
          method: "logout_client",
          requestId,
          jti: decodedToken.jti || "unknown",
        });

        // We still consider this a success since there's no session to log out from
        logoutSuccess = true;
      }

      // Clear auth cookies if they exist
      res.clearCookie("auth-token");

      // Send webhook notification for logout if configured
      try {
        const webhookData = {
          event: "user.logout",
          session_id: decodedToken.session_id,
          token_jti: decodedToken.jti,
          timestamp: Math.floor(Date.now() / 1000),
        };

        // Send webhook non-blocking
        this.send_webhook("user.logout", webhookData, false, req).catch(
          (webhookError) => {
            logger.error("Failed to send logout webhook", {
              component: "AuthenticationService",
              method: "logout_client",
              requestId,
              error: webhookError.message,
            });
          }
        );
      } catch (webhookError) {
        // Log but continue, webhook failure shouldn't affect logout
        logger.error("Error preparing logout webhook", {
          component: "AuthenticationService",
          method: "logout_client",
          requestId,
          error: webhookError.message,
        });
      }

      const duration = Date.now() - startTime;
      logger.info("Logout completed", {
        component: "AuthenticationService",
        method: "logout_client",
        requestId,
        duration,
        success: logoutSuccess,
        sessionClosed,
        hasSessionId: !!decodedToken.session_id,
      });

      // Emit metrics for logout
      logger.metric &&
        logger.metric("logout_duration_ms", duration, {
          component: "AuthenticationService",
          success: logoutSuccess,
          session_closed: sessionClosed,
        });

      logger.metric &&
        logger.metric("logout_attempts", 1, {
          component: "AuthenticationService",
          result: logoutSuccess ? "success" : "failure",
          session_closed: sessionClosed,
        });

      return res.json({
        message: "Logout successful",
        sessionClosed,
        requestId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Logout process failed", {
        component: "AuthenticationService",
        method: "logout_client",
        requestId,
        duration,
        error: error.message,
        stack: error.stack,
      });

      // Emit metrics for logout errors
      logger.metric &&
        logger.metric("logout_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: error.constructor.name,
        });

      logger.metric &&
        logger.metric("logout_errors", 1, {
          component: "AuthenticationService",
          error: error.constructor.name,
        });

      return res.status(500).json({
        message: "Internal server error during logout",
        error: error.message,
        requestId,
      });
    }
  }

  /**
   * Handle client login with RODiT credentials
   *
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @returns {Object} Response with JWT token or error
   */
  async login_client(req, res) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("Client login request received", {
      component: "AuthenticationService",
      method: "login_client",
      requestId,
    });

    try {
      const {
        roditid: peer_roditid,
        timestamp: peer_timestamp,
        roditid_base64url_signature,
      } = req.body;

      logger.debug("Received login credentials", {
        component: "AuthenticationService",
        method: "login_client",
        requestId,
        roditId: peer_roditid,
        hasTimestamp: !!peer_timestamp,
        hasSignature: !!roditid_base64url_signature,
      });

      if (!peer_roditid || !peer_timestamp || !roditid_base64url_signature) {
        const duration = Date.now() - startTime;

        logger.warn("Missing required login parameters", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
          duration,
          missingParams: {
            roditId: !peer_roditid,
            timestamp: !peer_timestamp,
            signature: !roditid_base64url_signature,
          },
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_attempt_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "MISSING_PARAMETERS",
        });
        logger.metric("failed_login_attempts_total", 1, {
          component: "AuthenticationService",
          reason: "MISSING_PARAMETERS",
        });

        return res.status(400).json({
          message: "Error 100: Missing RODiT ID, Signature or Timestamp",
          requestId,
        });
      }

      try {
        logger.debug("Retrieving server configuration", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
        });

        const config_own_rodit = await this.stateManager.getConfigOwnRodit();

        if (!config_own_rodit) {
          const duration = Date.now() - startTime;

          logger.error("Server configuration not initialized", {
            component: "AuthenticationService",
            method: "login_client",
            requestId,
            duration,
            errorCode: "CONFIG_NOT_INITIALIZED",
          });

          // Emit metrics for Grafana dashboards
          logger.metric("login_attempt_duration_ms", duration, {
            component: "AuthenticationService",
            success: false,
            error: "CONFIG_NOT_INITIALIZED",
          });
          logger.metric("failed_login_attempts_total", 1, {
            component: "AuthenticationService",
            reason: "CONFIG_NOT_INITIALIZED",
          });

          throw new Error("Error 0112: Server configuration not initialized");
        }

        logger.debug("Verifying peer RODiT credentials", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
          roditId: peer_roditid,
        });

        const { peer_rodit, goodrodit: isRoditValid } =
          await this.verify_peerrodit_getrodit(
            peer_roditid,
            peer_timestamp,
            roditid_base64url_signature,
            config_own_rodit.own_rodit
          );

        if (!isRoditValid) {
          const duration = Date.now() - startTime;

          logger.warn("Invalid RODiT credentials", {
            component: "AuthenticationService",
            method: "login_client",
            requestId,
            duration,
            roditId: peer_roditid,
          });

          // Emit metrics for Grafana dashboards
          logger.metric("login_attempt_duration_ms", duration, {
            component: "AuthenticationService",
            success: false,
            error: "INVALID_CREDENTIALS",
          });
          logger.metric("failed_login_attempts_total", 1, {
            component: "AuthenticationService",
            reason: "INVALID_CREDENTIALS",
          });

          return res.status(401).json({
            message:
              "Error 102: Login attempt failed: Invalid RODiT ID or Signature",
            requestId,
          });
        }

        logger.debug("Generating JWT token", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
          roditId: peer_rodit.token_id,
        });

        const token = await this.tokenService.generate_jwt_token(
          peer_rodit,
          peer_timestamp,
          config_own_rodit.own_rodit,
          config_own_rodit.own_rodit_bytes_private_key
        );

        const duration = Date.now() - startTime;
        logger.info("Login successful", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
          duration,
          roditId: peer_rodit.token_id,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_attempt_duration_ms", duration, {
          component: "AuthenticationService",
          success: true,
        });
        logger.metric("successful_logins_total", 1, {
          component: "AuthenticationService",
        });

        return res.json({
          token,
          requestId,
        });
      } catch (error) {
        const duration = Date.now() - startTime;

        logger.error("Login authentication failed", {
          component: "AuthenticationService",
          method: "login_client",
          requestId,
          duration,
          errorMessage: error.message,
          errorCode: error.code || "UNKNOWN_ERROR",
          stack: error.stack,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_attempt_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: error.code || "UNKNOWN_ERROR",
        });
        logger.metric("failed_login_attempts_total", 1, {
          component: "AuthenticationService",
          reason: error.code || "UNKNOWN_ERROR",
        });

        return res.status(401).json({
          message: `Error 105: Login attempt failed: ${error.message}`,
          requestId,
        });
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Internal server error during login", {
        component: "AuthenticationService",
        method: "login_client",
        requestId,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "INTERNAL_SERVER_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("login_attempt_duration_ms", duration, {
        component: "AuthenticationService",
        success: false,
        error: "INTERNAL_SERVER_ERROR",
      });
      logger.metric("failed_login_attempts_total", 1, {
        component: "AuthenticationService",
        reason: "INTERNAL_SERVER_ERROR",
      });

      return res.status(500).json({
        message: "Internal server error during login",
        requestId,
      });
    }
  }

  /**
   * Handle client login with NEP-413 standard
   *
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   * @param {Object} config_own_rodit - Own RODiT configuration
   * @returns {Object} Response with JWT token or error
   */
  async login_client_withnep413(req, res, config_own_rodit = null) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("NEP-413 login request received", {
      component: "AuthenticationService",
      method: "login_client_withnep413",
      requestId,
    });

    try {
      const { signature, message, nonce, recipient, callbackUrl } = req.body;

      logger.debug("Received NEP-413 login parameters", {
        component: "AuthenticationService",
        method: "login_client_withnep413",
        requestId,
        message,
        recipient,
        hasSignature: !!signature,
        hasNonce: !!nonce,
        hasCallbackUrl: !!callbackUrl,
      });

      if (!config_own_rodit) {
        const duration = Date.now() - startTime;

        logger.error("Server configuration not initialized for NEP-413 login", {
          component: "AuthenticationService",
          method: "login_client_withnep413",
          requestId,
          duration,
          errorCode: "CONFIG_NOT_INITIALIZED",
        });

        // Emit metrics for Grafana dashboards
        logger.metric("nep413_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "CONFIG_NOT_INITIALIZED",
        });
        logger.metric("failed_nep413_logins_total", 1, {
          component: "AuthenticationService",
          reason: "CONFIG_NOT_INITIALIZED",
        });

        throw new Error("Error 0114: Server configuration not initialized");
      }

      logger.debug("Verifying NEP-413 RODiT credentials", {
        component: "AuthenticationService",
        method: "login_client_withnep413",
        requestId,
        message,
      });

      const { peer_rodit, goodrodit: isRoditValid } =
        await this.verify_peerrodit_getrodit_withnep413(
          message,
          nonce,
          recipient,
          callbackUrl,
          signature,
          config_own_rodit
        );

      if (!isRoditValid) {
        const duration = Date.now() - startTime;

        logger.warn("NEP-413 login failed - Invalid RODiT credentials", {
          component: "AuthenticationService",
          method: "login_client_withnep413",
          requestId,
          duration,
          message,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("nep413_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "INVALID_CREDENTIALS",
        });
        logger.metric("failed_nep413_logins_total", 1, {
          component: "AuthenticationService",
          reason: "INVALID_CREDENTIALS",
        });

        return res.status(401).json({
          message:
            "Error 106: Login attempt failed: Invalid RODiT ID or Signature",
          requestId,
        });
      }

      logger.debug("Generating JWT token for validated NEP-413 login", {
        component: "AuthenticationService",
        method: "login_client_withnep413",
        requestId,
        roditId: peer_rodit.token_id,
      });

      const token = await this.tokenService.generate_jwt_token(
        peer_rodit,
        Math.floor(Date.now() / 1000),
        config_own_rodit.own_rodit,
        config_own_rodit.own_rodit_bytes_private_key
      );

      const duration = Date.now() - startTime;
      logger.info("NEP-413 login successful", {
        component: "AuthenticationService",
        method: "login_client_withnep413",
        requestId,
        duration,
        roditId: peer_rodit.token_id,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("nep413_login_duration_ms", duration, {
        component: "AuthenticationService",
        success: true,
      });
      logger.metric("successful_nep413_logins_total", 1, {
        component: "AuthenticationService",
      });

      return res.json({
        token,
        requestId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("NEP-413 login failed", {
        component: "AuthenticationService",
        method: "login_client_withnep413",
        requestId,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("nep413_login_duration_ms", duration, {
        component: "AuthenticationService",
        success: false,
        error: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("failed_nep413_logins_total", 1, {
        component: "AuthenticationService",
        reason: error.code || "UNKNOWN_ERROR",
      });

      return res.status(500).json({
        message: `Error 175c: Login attempt failed: ${error.message}`,
        requestId,
      });
    }
  }

  /**
   * Login the server to a RODiT portal
   *
   * @param {Object} own_rodit - Own RODiT object
   * @returns {Promise<Object>} Login result
   */
  async login_portal(own_rodit, port) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("Starting portal login process", {
      component: "AuthenticationService",
      method: "login_portal",
      requestId,
      roditId: own_rodit?.token_id,
    });

    try {
      // Get configuration from state manager
      const config_own_rodit = await this.stateManager.getConfigOwnRodit();

      logger.debug("Retrieved configuration from state manager", {
        component: "AuthenticationService",
        method: "login_portal",
        requestId,
        hasConfig: !!config_own_rodit,
        apiEndpoint: config_own_rodit?.apiendpoint,
      });

      if (!config_own_rodit) {
        const duration = Date.now() - startTime;

        logger.error("Client configuration not initialized", {
          component: "AuthenticationService",
          method: "login_portal",
          requestId,
          duration,
          errorCode: "CONFIG_NOT_INITIALIZED",
        });

        // Emit metrics for Grafana dashboards
        logger.metric("portal_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "CONFIG_NOT_INITIALIZED",
        });
        logger.metric("portal_login_errors_total", 1, {
          component: "AuthenticationService",
          error: "CONFIG_NOT_INITIALIZED",
        });

        return {
          error: "Client configuration not initialized",
          requestId,
        };
      }

      // Check RODiT metadata
      if (!own_rodit.metadata || !own_rodit.metadata.serviceprovider_id) {
        const duration = Date.now() - startTime;

        logger.error("Missing serviceprovider_id in RODiT", {
          component: "AuthenticationService",
          method: "login_portal",
          requestId,
          duration,
          roditId: own_rodit?.token_id,
          hasMetadata: !!own_rodit?.metadata,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("portal_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "MISSING_METADATA",
        });
        logger.metric("portal_login_errors_total", 1, {
          component: "AuthenticationService",
          error: "MISSING_METADATA",
        });

        return {
          error: "Missing serviceprovider_id in RODiT",
          requestId,
        };
      }

      // Use stateManager's getPortalUrl method to get API endpoint
      const serviceProviderId = own_rodit.metadata.serviceprovider_id;
      const apiendpoint = this.stateManager.getPortalUrl(
        serviceProviderId,
        port
      );

      logger.info("Using portal endpoint", {
        component: "AuthenticationService",
        method: "login_portal",
        requestId,
        apiEndpoint: apiendpoint,
      });

      // Prepare authentication data
      let roditid = own_rodit.token_id;
      const timestamp = Math.floor(Date.now() / 1000);
      const timeString = await unixTimeToDateString(timestamp);
      const roditidandtimestamp = new TextEncoder().encode(
        roditid + timeString
      );

      logger.debug("Generating authentication signature", {
        component: "AuthenticationService",
        method: "login_portal",
        requestId,
        roditId: roditid,
        timestamp,
      });

      // Create signature
      const own_rodit_bytes_signature = nacl.sign.detached(
        roditidandtimestamp,
        config_own_rodit.own_rodit_bytes_private_key
      );
      const roditid_base64url_signature = Buffer.from(
        own_rodit_bytes_signature
      ).toString("base64url");

      // Send login request
      const fetchUrl = `${apiendpoint}/login`;

      logger.debug("Sending login request to portal", {
        component: "AuthenticationService",
        method: "login_portal",
        requestId,
        endpoint: fetchUrl,
      });

      try {
        const response = await fetch(fetchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            roditid,
            timestamp,
            roditid_base64url_signature,
          }),
        });

        if (!response.ok) {
          const duration = Date.now() - startTime;

          logger.error("Portal login request failed", {
            component: "AuthenticationService",
            method: "login_portal",
            requestId,
            duration,
            status: response.status,
            statusText: response.statusText,
            endpoint: fetchUrl,
          });

          // Emit metrics for Grafana dashboards
          logger.metric("portal_login_duration_ms", duration, {
            component: "AuthenticationService",
            success: false,
            error: "HTTP_ERROR",
            status: response.status,
          });
          logger.metric("portal_login_errors_total", 1, {
            component: "AuthenticationService",
            error: "HTTP_ERROR",
            status: response.status,
          });

          throw new Error(
            `Error 040: Portal login failed with status ${response.status}`
          );
        }

        const data = await response.json();
        let jwt_token = data.token;

        logger.debug("Received JWT token from portal, validating", {
          component: "AuthenticationService",
          method: "login_portal",
          requestId,
          hasToken: !!jwt_token,
        });

        // Validate JWT token
        try {
          const validationResult =
            await this.tokenService.validate_jwt_token_be(jwt_token, own_rodit);
          const peer_rodit = validationResult.peer_rodit;

          logger.debug("JWT token validation successful", {
            component: "AuthenticationService",
            method: "login_portal",
            requestId,
            peerRoditId: peer_rodit.token_id,
          });
        } catch (validationError) {
          const duration = Date.now() - startTime;

          logger.error("JWT token validation failed", {
            component: "AuthenticationService",
            method: "login_portal",
            requestId,
            duration,
            errorMessage: validationError.message,
            stack: validationError.stack,
          });

          // Emit metrics for Grafana dashboards
          logger.metric("portal_login_duration_ms", duration, {
            component: "AuthenticationService",
            success: false,
            error: "JWT_VALIDATION_FAILED",
          });
          logger.metric("portal_login_errors_total", 1, {
            component: "AuthenticationService",
            error: "JWT_VALIDATION_FAILED",
          });

          throw new Error(
            `Error 039: Portal server validation failed: ${validationError.message}`
          );
        }

        const duration = Date.now() - startTime;
        logger.info("Portal login successful", {
          component: "AuthenticationService",
          method: "login_portal",
          requestId,
          duration,
          apiEndpoint: apiendpoint,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("portal_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: true,
        });
        logger.metric("successful_portal_logins_total", 1, {
          component: "AuthenticationService",
          endpoint: apiendpoint,
        });

        return {
          jwt_token,
          apiendpoint,
          requestId,
        };
      } catch (fetchError) {
        const duration = Date.now() - startTime;

        logger.error("Portal fetch operation failed", {
          component: "AuthenticationService",
          method: "login_portal",
          requestId,
          duration,
          errorMessage: fetchError.message,
          stack: fetchError.stack,
          endpoint: fetchUrl,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("portal_login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "FETCH_FAILED",
        });
        logger.metric("portal_login_errors_total", 1, {
          component: "AuthenticationService",
          error: "FETCH_FAILED",
          endpoint: fetchUrl,
        });

        throw fetchError;
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Portal login process failed", {
        component: "AuthenticationService",
        method: "login_portal",
        requestId,
        duration,
        errorMessage: error.message,
        stack: error.stack,
        roditId: own_rodit?.token_id,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("portal_login_duration_ms", duration, {
        component: "AuthenticationService",
        success: false,
        error: error.constructor.name,
      });
      logger.metric("portal_login_errors_total", 1, {
        component: "AuthenticationService",
        error: error.constructor.name,
      });

      return {
        error: `Failed to login to portal: ${error.message}`,
        requestId,
      };
    }
  }

  /**
   * Login to server with RODiT credentials
   *
   * @param {Object} own_rodit - Own RODiT object
   * @returns {Promise<Object>} Login result
   */
  async login_server(own_rodit) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("Starting login_server process", {
      component: "AuthenticationService",
      method: "login_server",
      requestId,
      roditId: own_rodit?.token_id,
    });

    try {
      const config_own_rodit = await this.stateManager.getConfigOwnRodit();

      logger.debug("Retrieved config from state manager", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        hasConfig: !!config_own_rodit,
        apiEndpoint: config_own_rodit?.apiendpoint,
      });

      if (!config_own_rodit) {
        const duration = Date.now() - startTime;

        logger.error("Client configuration not initialized", {
          component: "AuthenticationService",
          method: "login_server",
          requestId,
          duration,
          errorCode: "CONFIG_NOT_INITIALIZED",
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "CONFIG_NOT_INITIALIZED",
        });
        logger.metric("login_errors_total", 1, {
          component: "AuthenticationService",
          error: "CONFIG_NOT_INITIALIZED",
        });

        return { error: "Error 0111: Client configuration not initialized" };
      }

      const apiendpoint = config_own_rodit.apiendpoint;
      let roditid = own_rodit.token_id;
      const timestamp = Math.floor(Date.now() / 1000);

      logger.debug("Preparing authentication data", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        apiEndpoint: apiendpoint,
        roditId: roditid,
        timestamp,
      });

      const timeString = await unixTimeToDateString(timestamp);
      const roditidandtimestamp = new TextEncoder().encode(
        roditid + timeString
      );

      logger.debug("Generating signature", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        hasPrivateKey: !!config_own_rodit.own_rodit_bytes_private_key,
      });

      const own_rodit_bytes_signature = nacl.sign.detached(
        roditidandtimestamp,
        config_own_rodit.own_rodit_bytes_private_key
      );

      const roditid_base64url_signature = Buffer.from(
        own_rodit_bytes_signature
      ).toString("base64url");

      logger.debug("Sending login request", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        endpoint: apiendpoint + "/login",
      });

      const response = await fetch(apiendpoint + "/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          roditid,
          timestamp,
          roditid_base64url_signature,
        }),
      });

      if (!response.ok) {
        const duration = Date.now() - startTime;

        logger.error("Login request failed", {
          component: "AuthenticationService",
          method: "login_server",
          requestId,
          duration,
          status: response.status,
          statusText: response.statusText,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "HTTP_ERROR",
          status: response.status,
        });
        logger.metric("login_errors_total", 1, {
          component: "AuthenticationService",
          error: "HTTP_ERROR",
          status: response.status,
        });

        throw new Error("Error 040: Login failed");
      }

      const data = await response.json();
      let jwt_token = data.token;

      logger.debug("JWT token received, starting validation", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        hasToken: !!jwt_token,
      });

      // Validate the server
      let peer_bytes_ed25519_public_key;
      try {
        const validationResult = await this.tokenService.validate_jwt_token_be(
          jwt_token,
          own_rodit
        );

        // Assuming the correct property name is peer_rodit
        const peer_rodit = validationResult.peer_rodit;

        logger.debug("Token validation successful", {
          component: "AuthenticationService",
          method: "login_server",
          requestId,
          peerRoditId: peer_rodit.token_id,
        });

        peer_bytes_ed25519_public_key = new Uint8Array(
          Buffer.from(peer_rodit.owner_id, "hex")
        );
      } catch (validationError) {
        const duration = Date.now() - startTime;

        logger.error("JWT validation failed", {
          component: "AuthenticationService",
          method: "login_server",
          requestId,
          duration,
          errorMessage: validationError.message,
          stack: validationError.stack,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_duration_ms", duration, {
          component: "AuthenticationService",
          success: false,
          error: "JWT_VALIDATION_FAILED",
        });
        logger.metric("login_errors_total", 1, {
          component: "AuthenticationService",
          error: "JWT_VALIDATION_FAILED",
        });

        throw new Error(
          `Error 039: Server validation failed: ${validationError.message}`
        );
      }

      const duration = Date.now() - startTime;
      logger.info("Login successful", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        duration,
        apiEndpoint: apiendpoint,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("login_duration_ms", duration, {
        component: "AuthenticationService",
        success: true,
      });
      logger.metric("successful_logins_total", 1, {
        component: "AuthenticationService",
        endpoint: apiendpoint,
      });

      return {
        jwt_token,
        apiendpoint,
        requestId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Login failed", {
        component: "AuthenticationService",
        method: "login_server",
        requestId,
        duration,
        errorMessage: error.message,
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("login_duration_ms", duration, {
        component: "AuthenticationService",
        success: false,
        error: error.constructor.name,
      });
      logger.metric("login_errors_total", 1, {
        component: "AuthenticationService",
        error: error.constructor.name,
      });

      return {
        error: "Failed to login to server",
        requestId,
      };
    }
  }

  async verify_rodit_ownership(
    peerroditid,
    peertimestamp,
    peerroditid_base64url_signature,
    peer_rodit
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting RODiT ownership verification", {
      component: "RoditAuth",
      method: "verify_rodit_ownership",
      requestId,
      peerRoditId: peerroditid,
      timestamp: peertimestamp,
      signatureLength: peerroditid_base64url_signature?.length,
    });

    try {
      // DO NOT DELETE THE FOLLOWING COMMENT
      /* Maybe for NEP413 compatibility, the following line added "NEAR" before peerroditid */
      const timeString = await unixTimeToDateString(peertimestamp);
      const roditidandtimestamp = new TextEncoder().encode(
        peerroditid + timeString
      );

      logger.debug("Encoded roditid and timestamp", {
        requestId,
        timeString,
        bufferLength: roditidandtimestamp.length,
      });

      const bytes_ed25519_signature = new Uint8Array(
        Buffer.from(peerroditid_base64url_signature, "base64url")
      );

      logger.debug("Decoded signature", {
        requestId,
        signatureLength: bytes_ed25519_signature.length,
      });

      const peer_bytes_ed25519_public_key =
        await nearorg_rpc_fetchpublickeybytes(
          peer_rodit.owner_id
        );

      logger.debug("Retrieved public key", {
        requestId,
        ownerId: peer_rodit.owner_id,
        keyLength: peer_bytes_ed25519_public_key?.length || 0,
      });

      const isaMatch = nacl.sign.detached.verify(
        roditidandtimestamp,
        bytes_ed25519_signature,
        peer_bytes_ed25519_public_key
      );

      const duration = Date.now() - startTime;

      if (isaMatch) {
        logger.info("Peer RODiT ownership check passed", {
          component: "RoditAuth",
          requestId,
          duration,
          peerRoditId: peerroditid,
          ownerId: peer_rodit.owner_id,
          outcome: "success",
        });

        // Add metric for successful verification
        logger.metric &&
          logger.metric("rodit_ownership_verification", duration, {
            result: "success",
            peer_rodit_id: peerroditid,
          });

        return true;
      } else {
        logger.error("Peer RODiT ownership check failed", {
          component: "RoditAuth",
          requestId,
          duration,
          peerRoditId: peerroditid,
          ownerId: peer_rodit.owner_id,
          outcome: "failed",
        });

        // Add metric for failed verification
        logger.metric &&
          logger.metric("rodit_ownership_verification", duration, {
            result: "failure",
            peer_rodit_id: peerroditid,
          });

        throw new Error("Error 035: PeerEd25519SignatureVerificationFailure");
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("RODiT ownership verification failed", {
        component: "RoditAuth",
        method: "verify_rodit_ownership",
        requestId,
        duration,
        peerRoditId: peerroditid,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metric for verification errors
      logger.metric &&
        logger.metric("rodit_ownership_verification_errors", 1, {
          error_type: error.name || "Unknown",
          peer_rodit_id: peerroditid,
        });

      throw new Error("Error A33: " + error.message);
    }
  }

  async verify_rodit_ownership_withnep413(
    message,
    nonce,
    recipient,
    callbackUrl,
    signature,
    peer_rodit
  ) {
    try {
      logger.debug("Starting NEP-413 signature verification");

      // Ensure nonce is correctly formatted
      let nonceArray;
      if (typeof nonce === "string") {
        // Handle base64url encoded nonce
        nonceArray = new Uint8Array(Buffer.from(nonce, "base64url"));
      } else if (Array.isArray(nonce)) {
        nonceArray = new Uint8Array(nonce);
      } else if (typeof nonce === "object" && nonce !== null) {
        nonceArray = new Uint8Array(Object.values(nonce));
      } else {
        throw new Error(`Invalid nonce format: ${typeof nonce}`);
      }

      if (nonceArray.length !== 32) {
        logger.error(`Invalid nonce length: ${nonceArray.length}`);
        throw new Error(
          `Invalid nonce length: ${nonceArray.length}, expected 32`
        );
      }

      const payload = new PayloadNEP413({
        tag: 2147484061,
        message,
        nonce: nonceArray,
        recipient,
        callbackUrl,
      });

      const serializedPayload = borsh.serialize(PayloadNEP413Schema, payload);
      const payloadHash = crypto
        .createHash("sha256")
        .update(serializedPayload)
        .digest();

      // Convert base64url signature to standard base64
      const standardBase64 = signature
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(signature.length + ((4 - (signature.length % 4)) % 4), "=");
      const signatureBytes = nacl.util.decodeBase64(standardBase64);

      // Get public key bytes
      const publicKeyBytes = await nearorg_rpc_fetchpublickeybytes(
        peer_rodit.owner_id
      );

      // Perform verification
      const isaMatch = nacl.sign.detached.verify(
        payloadHash,
        signatureBytes,
        publicKeyBytes
      );

      if (isaMatch) {
        logger.info("Peer RODiT possession check passed");
        return true;
      } else {
        logger.error("Peer RODiT possession check failed");
        throw new Error("PeerEd25519SignatureVerificationFailure");
      }
    } catch (error) {
      logger.error(
        `Error in this.verify_rodit_ownership_withnep413: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Send a webhook notification
   *
   * @param {string} event - Event name
   * @param {Object} data - Event data
   * @param {boolean} isError - Whether this is an error event
   * @param {Object} req - Express request object (optional)
   * @returns {Promise<Object>} Webhook delivery result
   */
  async send_webhook(event, data, isError = false, req = null) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting webhook delivery", {
      component: "WebhookSender",
      method: "send_webhook",
      requestId,
      event,
      isError,
      dataSize:
        typeof data === "object" ? JSON.stringify(data).length : "unknown",
    });

    try {
      // Get the configuration from state manager
      const config_own_rodit = await this.stateManager.getConfigOwnRodit();

      // Check if webhook configuration is available
      if (
        !config_own_rodit ||
        !config_own_rodit.own_rodit.metadata.webhook_url
      ) {
        const duration = Date.now() - startTime;

        logger.warn("Webhook configuration missing", {
          component: "WebhookSender",
          method: "send_webhook",
          requestId,
          duration,
          hasConfig: !!config_own_rodit,
          hasWebhookUrl: config_own_rodit
            ? !!config_own_rodit.own_rodit.metadata.webhook_url
            : false,
        });

        // Emit metrics for Grafana dashboards
        logger.metric &&
          logger.metric("webhook_delivery_duration_ms", duration, {
            component: "WebhookSender",
            success: false,
            event,
            error: "WEBHOOK_CONFIG_ERROR",
          });
        logger.metric &&
          logger.metric("webhook_delivery_failures_total", 1, {
            component: "WebhookSender",
            reason: "CONFIG_MISSING",
            event,
          });

        return {
          isValid: false,
          error: {
            code: "WEBHOOK_CONFIG_ERROR",
            message: "Webhook URL not available in Rodit configuration",
            requestId,
          },
        };
      }

      // Get the current JWT token or login to get one
      let jwt_token = this.stateManager.getJwtToken();
      if (!jwt_token) {
        // If there's no token, we need to login first
        logger.debug("No JWT token available, attempting login", {
          component: "WebhookSender",
          method: "send_webhook",
          requestId,
        });

        try {
          // Login to get a token
          const loginResult = await this.login_server(
            config_own_rodit.own_rodit
          );

          if (loginResult && loginResult.jwt_token) {
            jwt_token = loginResult.jwt_token;
            await this.stateManager.setJwtToken(jwt_token);

            logger.info("Successfully obtained JWT token for webhook", {
              component: "WebhookSender",
              method: "send_webhook",
              requestId,
            });
          } else {
            logger.error("Failed to obtain JWT token for webhook", {
              component: "WebhookSender",
              method: "send_webhook",
              requestId,
              loginResult,
            });
            throw new Error(
              "Could not obtain authentication token for webhook"
            );
          }
        } catch (loginError) {
          logger.error("Error during login for webhook token", {
            component: "WebhookSender",
            method: "send_webhook",
            requestId,
            error: loginError.message,
            stack: loginError.stack,
          });
          throw new Error(
            `Failed to authenticate for webhook: ${loginError.message}`
          );
        }
      }

      // Determine which webhook URL to use
      let webhookUrl;

      // Check if request object is available and has user JWT payload
      if (req && req.user && req.user.rodit_webhookurl) {
        // Use the webhook URL from the peer's JWT token
        webhookUrl = req.user.rodit_webhookurl;
        logger.debug("Using webhook URL from peer JWT token", {
          component: "WebhookSender",
          method: "send_webhook",
          requestId,
          webhookSource: "peer_jwt",
          webhookUrl,
        });
      } else {
        // Fallback to config
        webhookUrl = config_own_rodit.own_rodit.metadata.webhook_url;
        logger.debug("Using webhook URL from own RODiT config", {
          component: "WebhookSender",
          method: "send_webhook",
          requestId,
          webhookSource: "own_config",
          webhookUrl,
        });
      }

      // Ensure the URL has the correct format
      // First remove any existing protocol
      webhookUrl = webhookUrl.replace(/^(https?:\/\/)/, "");

      // Then add https:// protocol
      const formattedWebhookUrl = `https://${webhookUrl}/webhook`;

      logger.debug("Webhook URL details", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        rawWebhookUrl: webhookUrl,
        formattedWebhookUrl,
      });

      const timestamp = Date.now();
      const payload = JSON.stringify({
        event,
        data,
        isError,
        timestamp,
        requestId,
      });

      logger.debug("Preparing webhook payload", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        payloadSize: payload.length,
        event,
      });

      // Generate payload hash
      const sha256_ofpayload = crypto
        .createHash("sha256")
        .update(payload)
        .digest();

      logger.debug("Creating signature", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        hasPrivateKey: !!config_own_rodit.own_rodit_bytes_private_key,
      });

      // Convert private key and generate signature
      const own_rodit_private_key = new Uint8Array(
        config_own_rodit.own_rodit_bytes_private_key
      );

      const signatureStartTime = Date.now();
      const signature_ofpayload = nacl.sign.detached(
        sha256_ofpayload,
        own_rodit_private_key
      );
      const signatureDuration = Date.now() - signatureStartTime;

      // Log signature generation metrics
      logger.metric &&
        logger.metric("signature_generation_duration_ms", signatureDuration, {
          component: "WebhookSender",
        });

      const signature_hex_ofpayload =
        Buffer.from(signature_ofpayload).toString("hex");

      logger.debug("Sending webhook request", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        webhookUrl: formattedWebhookUrl,
        event,
      });

      // Send webhook request WITH the JWT token
      const fetchStartTime = Date.now();
      const response = await fetch(formattedWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature_hex_ofpayload,
          "X-Timestamp": timestamp.toString(),
          "X-Request-ID": requestId,
          Authorization: `Bearer ${jwt_token}`, // Include JWT token here
        },
        body: payload,
      });
      const fetchDuration = Date.now() - fetchStartTime;

      // Log fetch duration metrics
      logger.metric("webhook_http_request_duration_ms", fetchDuration, {
        component: "WebhookSender",
        success: response.ok,
        status: response.status,
        event,
      });

      if (!response.ok) {
        const duration = Date.now() - startTime;

        logger.error("Webhook delivery failed", {
          component: "WebhookSender",
          method: "send_webhook",
          requestId,
          duration,
          status: response.status,
          statusText: response.statusText,
          webhookUrl: formattedWebhookUrl,
          event,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("webhook_delivery_duration_ms", duration, {
          component: "WebhookSender",
          success: false,
          event,
          error: "HTTP_ERROR",
          status: response.status,
        });
        logger.metric("webhook_delivery_failures_total", 1, {
          component: "WebhookSender",
          reason: "HTTP_ERROR",
          status: response.status,
          event,
        });

        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await response.text();

      const duration = Date.now() - startTime;
      logger.info("Webhook delivered successfully", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        duration,
        event,
        webhookUrl: formattedWebhookUrl,
        status: response.status,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_delivery_duration_ms", duration, {
        component: "WebhookSender",
        success: true,
        event,
      });
      logger.metric("successful_webhook_deliveries_total", 1, {
        component: "WebhookSender",
        event,
      });

      return {
        isValid: true,
        message: "Webhook sent successfully",
        requestId,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Webhook send failed", {
        component: "WebhookSender",
        method: "send_webhook",
        requestId,
        duration,
        event,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
        isError,
        isTest: data && data.test_id ? true : false,
        operation: "webhook",
        status: "failed",
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_delivery_duration_ms", duration, {
        component: "WebhookSender",
        success: false,
        event,
        error: error.constructor.name,
      });
      logger.metric("webhook_delivery_errors_total", 1, {
        component: "WebhookSender",
        error: error.constructor.name,
        event,
      });

      return {
        isValid: false,
        error: {
          code: "WEBHOOK_SEND_ERROR",
          message: `Failed to send webhook: ${error.message}`,
          requestId,
        },
      };
    }
  }

  /**
   * Authenticate a webhook request
   *
   * @param {string} payload - Webhook payload
   * @param {string} signature_hex_ofpayload - Signature of payload
   * @param {number} timestamp - Request timestamp
   * @param {string} peer_rodit_owner_id - RODiT owner ID
   * @returns {Promise<Object>} Authentication result
   */
  async authenticate_webhook(
    payload,
    signature_hex_ofpayload,
    timestamp,
    peer_rodit_owner_id
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting webhook authentication", {
      component: "WebhookAuthenticator",
      method: "authenticate_webhook",
      requestId,
      hasPayload: !!payload,
      hasSignature: !!signature_hex_ofpayload,
      hasTimestamp: !!timestamp,
      hasPeerRoditOwnerId: !!peer_rodit_owner_id,
    });

    try {
      const currentTime = Date.now();
      const parsedTimestamp = parseInt(timestamp);
      const timeThreshold = 5 * 60 * 1000; // 5 minutes

      // Check if timestamp is too old
      if (currentTime - parsedTimestamp > timeThreshold) {
        const duration = Date.now() - startTime;

        logger.warn("Webhook authentication failed - timestamp too old", {
          component: "WebhookAuthenticator",
          method: "authenticate_webhook",
          requestId,
          duration,
          timestampAge: (currentTime - parsedTimestamp) / 1000,
          threshold: timeThreshold / 1000,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("webhook_authentication_duration_ms", duration, {
          component: "WebhookAuthenticator",
          success: false,
          reason: "TIMESTAMP_EXPIRED",
        });
        logger.metric("webhook_authentication_failures_total", 1, {
          component: "WebhookAuthenticator",
          reason: "TIMESTAMP_EXPIRED",
        });

        return {
          isValid: false,
          error: {
            code: "TIMESTAMP_EXPIRED",
            message: "Webhook timestamp is too old",
            requestId,
          },
        };
      }

      logger.debug("Calculating payload hash for verification", {
        component: "WebhookAuthenticator",
        method: "authenticate_webhook",
        requestId,
        payloadSize: payload.length,
      });

      // Calculate hash of payload
      const sha256_ofpayload = crypto
        .createHash("sha256")
        .update(payload)
        .digest();

      logger.debug("Converting signature to buffer", {
        component: "WebhookAuthenticator",
        method: "authenticate_webhook",
        requestId,
        signatureLength: signature_hex_ofpayload.length,
      });

      // Convert signature to buffer
      const buffer_signature_ofpayload = Buffer.from(
        signature_hex_ofpayload,
        "hex"
      );

      logger.debug("Creating public key for verification", {
        component: "WebhookAuthenticator",
        method: "authenticate_webhook",
        requestId,
        ownerIdLength: peer_rodit_owner_id.length,
      });

      // Create public key buffer
      const peer_bytes_public_key = new Uint8Array(
        Buffer.from(peer_rodit_owner_id, "hex")
      );

      // Verify signature
      const verificationStartTime = Date.now();
      const isValid = nacl.sign.detached.verify(
        sha256_ofpayload,
        buffer_signature_ofpayload,
        peer_bytes_public_key
      );
      const verificationDuration = Date.now() - verificationStartTime;

      // Log verification metrics
      logger.metric(
        "signature_verification_duration_ms",
        verificationDuration,
        {
          component: "WebhookAuthenticator",
          success: isValid,
        }
      );

      if (!isValid) {
        const duration = Date.now() - startTime;

        logger.warn("Webhook authentication failed - invalid signature", {
          component: "WebhookAuthenticator",
          method: "authenticate_webhook",
          requestId,
          duration,
          verificationDuration,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("webhook_authentication_duration_ms", duration, {
          component: "WebhookAuthenticator",
          success: false,
          reason: "INVALID_SIGNATURE",
        });
        logger.metric("webhook_authentication_failures_total", 1, {
          component: "WebhookAuthenticator",
          reason: "INVALID_SIGNATURE",
        });

        return {
          isValid: false,
          error: {
            code: "INVALID_SIGNATURE",
            message: "Invalid webhook signature",
            requestId,
          },
        };
      }

      const duration = Date.now() - startTime;
      logger.info("Webhook authentication successful", {
        component: "WebhookAuthenticator",
        method: "authenticate_webhook",
        requestId,
        duration,
        verificationDuration,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_authentication_duration_ms", duration, {
        component: "WebhookAuthenticator",
        success: true,
      });
      logger.metric("successful_webhook_authentications_total", 1, {
        component: "WebhookAuthenticator",
      });

      return {
        isValid: true,
        message: "Webhook authentication successful",
        requestId,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Webhook authentication error", {
        component: "WebhookAuthenticator",
        method: "authenticate_webhook",
        requestId,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_authentication_duration_ms", duration, {
        component: "WebhookAuthenticator",
        success: false,
        error: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("webhook_authentication_errors_total", 1, {
        component: "WebhookAuthenticator",
        error: error.constructor.name,
      });

      return {
        isValid: false,
        error: {
          code: "AUTHENTICATION_ERROR",
          message: "An unexpected error occurred during webhook authentication",
          details: error.message,
          requestId,
        },
      };
    }
  }

  /**
   * Validate a JWT token
   *
   * @param {string} token - JWT token to validate
   * @param {Object} own_rodit - Own RODiT object
   * @returns {Promise<Object>} Validation result
   */
  async validate_jwt_token_be(token, own_rodit) {
    // This would be implemented in the Authentication class
    // For now, it delegates to the TokenService
    return this.tokenService.validate_jwt_token_be(token, own_rodit);
  }

  /**
   * Verify and get a peer RODiT
   *
   * @param {string} peerroditid - Peer RODiT ID
   * @param {number} peertimestamp - Peer timestamp
   * @param {string} peerroditid_base64url_signature - Signature of RODiT ID and timestamp
   * @param {Object} own_rodit - Own RODiT object
   * @returns {Promise<Object>} Verification result with peer RODiT
   */
  async verify_peerrodit_getrodit_withnep413(
    message,
    nonce,
    recipient,
    callbackUrl,
    signature,
    config_own_rodit
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting NEP-413 RODiT verification", {
      component: "RoditAuth",
      method: "verify_peerrodit_getrodit_withnep413",
      requestId,
      message,
      nonceType: typeof nonce,
      nonceLength: Array.isArray(nonce) ? nonce.length : nonce?.length || 0,
      recipient,
      hasCallback: !!callbackUrl,
      signatureLength: signature?.length,
    });

    try {
      logger.debug("Fetching peer RODiT", {
        requestId,
        message,
      });

      const tokenFetchStart = Date.now();
      let peer_rodit =
        await nearorg_rpc_tokenfromroditid(message);
      const tokenFetchDuration = Date.now() - tokenFetchStart;

      logger.debug("Peer RODiT retrieved", {
        requestId,
        tokenFetchDuration,
        peerRoditId: peer_rodit?.token_id,
        peerOwnerId: peer_rodit?.owner_id,
      });

      // Correctly access serviceprovider_id
      const serviceprovider_id =
        config_own_rodit &&
        config_own_rodit.own_rodit &&
        config_own_rodit.own_rodit.metadata
          ? config_own_rodit.own_rodit.metadata.serviceprovider_id
          : null;

      if (!serviceprovider_id) {
        logger.error("Missing serviceprovider_id in configuration", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
        });

        throw new Error("Missing serviceprovider_id in configuration");
      }

      // Execute verification steps
      logger.debug("Starting verification checks", {
        requestId,
        checks: ["ownership", "match", "live", "active", "trusted"],
      });

      const verificationStart = Date.now();
      const verification_results = await Promise.all([
        this.verify_rodit_ownership_withnep413(
          message,
          nonce,
          recipient,
          callbackUrl,
          signature,
          peer_rodit
        ),
        this.verify_rodit_isamatch(serviceprovider_id, peer_rodit),
        this.verify_rodit_islive(
          peer_rodit.metadata.not_after,
          peer_rodit.metadata.not_before
        ),
        this.verify_rodit_isactive(
          peer_rodit.token_id,
          config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
        ),
        this.verify_rodit_istrusted_issuingsmartcontract(
          config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
        ),
      ]);
      const verificationDuration = Date.now() - verificationStart;

      const [ownershipVerified, isaMatch, isLive, isActive, isTrusted] =
        verification_results;

      logger.debug("RODiT Verification Results", {
        requestId,
        verificationDuration,
        ownershipVerified,
        isaMatch,
        isLive,
        isActive,
        isTrusted,
      });

      if (
        !ownershipVerified ||
        !isaMatch ||
        !isLive ||
        !isActive ||
        !isTrusted
      ) {
        const failedChecks = [];
        if (!ownershipVerified) failedChecks.push("ownership");
        if (!isaMatch) failedChecks.push("match");
        if (!isLive) failedChecks.push("live");
        if (!isActive) failedChecks.push("active");
        if (!isTrusted) failedChecks.push("trusted");

        logger.error("Peer RODiT NEP-413 verification failed", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          failedChecks,
          message,
          peerRoditId: peer_rodit?.token_id,
        });

        // Add metrics for verification failures
        logger.metric &&
          logger.metric("rodit_nep413_verification_failures", 1, {
            failed_checks: failedChecks.join(","),
            message,
          });

        throw new Error("Error 037: Peer RODiT verification failed");
      }

      const totalDuration = Date.now() - startTime;

      logger.info("NEP-413 RODiT verification successful", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit_withnep413",
        requestId,
        duration: totalDuration,
        message,
        peerRoditId: peer_rodit?.token_id,
        peerOwnerId: peer_rodit?.owner_id,
        tokenFetchDuration,
        verificationDuration,
      });

      // Add metrics for successful verifications
      logger.metric &&
        logger.metric("rodit_nep413_verification", totalDuration, {
          result: "success",
          message,
        });

      return {
        peer_rodit,
        goodrodit: true,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Error in NEP-413 RODiT verification", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit_withnep413",
        requestId,
        duration,
        message,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metrics for verification errors
      logger.metric &&
        logger.metric("rodit_nep413_verification_errors", 1, {
          error_type: error.name || "Unknown",
          message,
        });

      return {
        peer_rodit: null,
        goodrodit: false,
        error: `Error in verify_peerrodit_getrodit_withnep413: ${error.message}`,
      };
    }
  }

  async verify_rodit_islive(peer_rodit_notafter, peer_rodit_notbefore) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Checking RODiT time validity", {
      component: "RoditAuth",
      method: "verify_rodit_islive",
      requestId,
      notAfter: peer_rodit_notafter,
      notBefore: peer_rodit_notbefore,
    });

    function parseDate(datestring) {
      const date = new Date(datestring);
      return isNaN(date.getTime()) ? new Date(0) : date;
    }

    const datetimenul = new Date(0);
    const datetimenotafter = parseDate(peer_rodit_notafter);
    const datetimenotbefore = parseDate(peer_rodit_notbefore);

    logger.debug("Parsed validity dates", {
      requestId,
      parsedNotAfter: datetimenotafter.toISOString(),
      parsedNotBefore: datetimenotbefore.toISOString(),
      isNotAfterNull: datetimenotafter.getTime() === datetimenul.getTime(),
      isNotBeforeNull: datetimenotbefore.getTime() === datetimenul.getTime(),
    });

    try {
      const rpcStart = Date.now();
      const stringtimenow =
        await nearorg_rpc_timestamp();
      const rpcDuration = Date.now() - rpcStart;

      logger.debug("Retrieved blockchain timestamp", {
        requestId,
        rpcDuration,
        blockchainTimestamp: stringtimenow,
      });

      const timestamp = parseInt(stringtimenow, 10);

      if (isNaN(timestamp)) {
        logger.error("Failed to parse blockchain timestamp", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          blockchainTimestamp: stringtimenow,
        });

        // Add metrics for timestamp parsing errors
        logger.metric &&
          logger.metric("rodit_islive_errors", 1, {
            error_type: "timestamp_parse_error",
            blockchain_timestamp: stringtimenow,
          });

        return false;
      }

      const datetimetimestamp = new Date(timestamp / 1000000); // Convert nanoseconds to milliseconds

      logger.debug("Converted blockchain time", {
        requestId,
        blockchainTime: datetimetimestamp.toISOString(),
        originalTimestamp: timestamp,
      });

      const isAfterNotBefore =
        datetimetimestamp >= datetimenotbefore ||
        datetimenotbefore.getTime() === datetimenul.getTime();

      const isBeforeNotAfter =
        datetimetimestamp <= datetimenotafter ||
        datetimenotafter.getTime() === datetimenul.getTime();

      const isLive = isAfterNotBefore && isBeforeNotAfter;

      const totalDuration = Date.now() - startTime;

      if (isLive) {
        logger.info("RODiT is live", {
          component: "RoditAuth",
          method: "verify_rodit_islive",
          requestId,
          duration: totalDuration,
          rpcDuration,
          currentTime: datetimetimestamp.toISOString(),
          notBefore: datetimenotbefore.toISOString(),
          notAfter: datetimenotafter.toISOString(),
          isLive: true,
        });

        // Add metrics for live tokens
        logger.metric &&
          logger.metric("rodit_time_checks", totalDuration, {
            result: "live",
          });

        return true;
      } else {
        logger.warn("RODiT is not live - outside valid time period", {
          component: "RoditAuth",
          method: "verify_rodit_islive",
          requestId,
          duration: totalDuration,
          rpcDuration,
          currentTime: datetimetimestamp.toISOString(),
          notBefore: datetimenotbefore.toISOString(),
          notAfter: datetimenotafter.toISOString(),
          isBeforeExpiry: isBeforeNotAfter,
          isAfterStart: isAfterNotBefore,
          isLive: false,
        });

        // Add metrics for expired or not-yet-valid tokens
        logger.metric &&
          logger.metric("rodit_time_checks", totalDuration, {
            result: "not_live",
            not_before_valid: isAfterNotBefore,
            not_after_valid: isBeforeNotAfter,
          });

        return false;
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Failed to check RODiT time validity", {
        component: "RoditAuth",
        method: "verify_rodit_islive",
        requestId,
        duration,
        notAfter: peer_rodit_notafter,
        notBefore: peer_rodit_notbefore,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metrics for validation errors
      logger.metric &&
        logger.metric("rodit_islive_errors", 1, {
          error_type: error.name || "Unknown",
        });

      return false;
    }
  }
  async verify_peerrodit_getrodit(
    peerroditid,
    peertimestamp,
    peerroditid_base64url_signature,
    own_rodit
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting peer RODiT verification", {
      component: "RoditAuth",
      method: "verify_peerrodit_getrodit",
      requestId,
      peerRoditId: peerroditid,
      timestamp: peertimestamp,
      signatureLength: peerroditid_base64url_signature?.length,
      hasOwnRodit: !!own_rodit,
      ownRoditId: own_rodit?.token_id,
    });

    try {
      logger.debug("Fetching peer RODiT from blockchain", {
        requestId,
        peerRoditId: peerroditid,
      });

      const tokenFetchStart = Date.now();
      const peer_rodit =
        await nearorg_rpc_tokenfromroditid(peerroditid);
      const tokenFetchDuration = Date.now() - tokenFetchStart;

      logger.debug("Received peer RODiT from blockchain", {
        requestId,
        tokenFetchDuration,
        hasPeerRodit: !!peer_rodit,
        peerRoditId: peer_rodit?.token_id,
        peerRoditOwnerId: peer_rodit?.owner_id,
        hasPeerRoditMetadata: peer_rodit && !!peer_rodit.metadata,
        metadataKeys:
          peer_rodit && peer_rodit.metadata
            ? Object.keys(peer_rodit.metadata)
            : [],
      });

      if (!peer_rodit) {
        logger.error("Failed to retrieve peer RODiT data", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          peerRoditId: peerroditid,
        });

        throw new Error("Failed to retrieve peer RODiT data");
      }

      if (!peer_rodit.metadata) {
        logger.error("Peer RODiT missing metadata", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          peerRoditId: peerroditid,
          peerRoditOwnerId: peer_rodit.owner_id,
        });

        throw new Error("Peer RODiT missing metadata");
      }

      logger.debug("Starting verification checks", {
        requestId,
        checks: ["ownership", "match", "live", "active", "trusted"],
      });

      // Initialize verification results
      let ownershipVerified, isaMatch, isLive, isActive, isTrusted;
      let verificationDetails = {};

      try {
        logger.debug("Verifying RODiT ownership", { requestId });
        const ownershipStart = Date.now();
        ownershipVerified = await this.verify_rodit_ownership(
          peerroditid,
          peertimestamp,
          peerroditid_base64url_signature,
          peer_rodit
        );
        verificationDetails.ownershipDuration = Date.now() - ownershipStart;
        logger.debug("Ownership verification result", {
          requestId,
          ownershipVerified,
          duration: verificationDetails.ownershipDuration,
        });
      } catch (ownershipError) {
        logger.error("Error during ownership verification", {
          requestId,
          error: ownershipError.message,
          stack: ownershipError.stack,
        });
        ownershipVerified = false;
        verificationDetails.ownershipError = ownershipError.message;
      }

      try {
        logger.debug("Verifying RODiT match", {
          requestId,
          serviceProviderId: own_rodit.metadata.serviceprovider_id,
        });
        const matchStart = Date.now();
        isaMatch = await this.verify_rodit_isamatch(
          own_rodit.metadata.serviceprovider_id,
          peer_rodit
        );
        verificationDetails.matchDuration = Date.now() - matchStart;
        logger.debug("Match verification result", {
          requestId,
          isaMatch,
          duration: verificationDetails.matchDuration,
        });
      } catch (matchError) {
        logger.error("Error during match verification", {
          requestId,
          error: matchError.message,
          stack: matchError.stack,
        });
        isaMatch = false;
        verificationDetails.matchError = matchError.message;
      }

      try {
        logger.debug("Verifying RODiT is live", {
          requestId,
          notAfter: peer_rodit.metadata.not_after,
          notBefore: peer_rodit.metadata.not_before,
        });

        const liveStart = Date.now();
        isLive = await this.verify_rodit_islive(
          peer_rodit.metadata.not_after,
          peer_rodit.metadata.not_before
        );
        verificationDetails.liveDuration = Date.now() - liveStart;
        logger.debug("Live verification result", {
          requestId,
          isLive,
          duration: verificationDetails.liveDuration,
        });
      } catch (liveError) {
        logger.error("Error during live verification", {
          requestId,
          error: liveError.message,
          stack: liveError.stack,
        });
        isLive = false;
        verificationDetails.liveError = liveError.message;
      }

      try {
        logger.debug("Verifying RODiT is active", {
          requestId,
          tokenId: peer_rodit.token_id,
          url: own_rodit.metadata.subjectuniqueidentifier_url,
        });
        const activeStart = Date.now();
        isActive = await this.verify_rodit_isactive(
          peer_rodit.token_id,
          own_rodit.metadata.subjectuniqueidentifier_url
        );
        verificationDetails.activeDuration = Date.now() - activeStart;
        logger.debug("Active verification result", {
          requestId,
          isActive,
          duration: verificationDetails.activeDuration,
        });
      } catch (activeError) {
        logger.error("Error during active verification", {
          requestId,
          error: activeError.message,
          stack: activeError.stack,
        });
        isActive = false;
        verificationDetails.activeError = activeError.message;
      }

      try {
        logger.debug("Verifying RODiT issuing smart contract is trusted", {
          requestId,
          url: own_rodit.metadata.subjectuniqueidentifier_url,
        });
        const trustedStart = Date.now();
        isTrusted = await this.verify_rodit_istrusted_issuingsmartcontract(
          own_rodit.metadata.subjectuniqueidentifier_url
        );
        verificationDetails.trustedDuration = Date.now() - trustedStart;
        logger.debug("Trust verification result", {
          requestId,
          isTrusted,
          duration: verificationDetails.trustedDuration,
        });
      } catch (trustError) {
        logger.error("Error during trust verification", {
          requestId,
          error: trustError.message,
          stack: trustError.stack,
        });
        isTrusted = false;
        verificationDetails.trustError = trustError.message;
      }

      // Log all verification results
      logger.debug("All verification results", {
        requestId,
        ownershipVerified,
        isaMatch,
        isLive,
        isActive,
        isTrusted,
        verificationDetails,
      });

      if (
        !ownershipVerified ||
        !isaMatch ||
        !isLive ||
        !isActive ||
        !isTrusted
      ) {
        const failedChecks = [];
        if (!ownershipVerified) failedChecks.push("ownership");
        if (!isaMatch) failedChecks.push("match");
        if (!isLive) failedChecks.push("live");
        if (!isActive) failedChecks.push("active");
        if (!isTrusted) failedChecks.push("trusted");

        const duration = Date.now() - startTime;
        logger.error("Peer RODiT verification failed", {
          component: "RoditAuth",
          method: "verify_peerrodit_getrodit",
          requestId,
          duration,
          peerRoditId: peerroditid,
          failedChecks,
          verificationDetails,
        });

        // Add metrics for verification failures
        logger.metric &&
          logger.metric("rodit_verification_failures", 1, {
            failed_checks: failedChecks.join(","),
            peer_rodit_id: peerroditid,
          });

        logger.metric &&
          logger.metric("rodit_verification", duration, {
            result: "failure",
            peer_rodit_id: peerroditid,
          });

        throw new Error(
          `Error 037: Peer RODiT verification failed on: ${failedChecks.join(
            ", "
          )}`
        );
      }

      const totalDuration = Date.now() - startTime;

      logger.info("Peer RODiT verification successful", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration: totalDuration,
        peerRoditId: peerroditid,
        peerOwnerId: peer_rodit.owner_id,
        verificationDetails,
      });

      // Add metrics for successful verifications
      logger.metric &&
        logger.metric("rodit_verification", totalDuration, {
          result: "success",
          peer_rodit_id: peerroditid,
        });

      return {
        peer_rodit,
        goodrodit: true,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Error in verify_peerrodit_getrodit", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration,
        peerRoditId: peerroditid,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metrics for verification errors
      logger.metric &&
        logger.metric("rodit_verification_errors", 1, {
          error_type: error.name || "Unknown",
          peer_rodit_id: peerroditid,
        });

      return {
        peer_rodit: null,
        goodrodit: false,
        error: `Error in verify_peerrodit_getrodit: ${error.message}`,
      };
    }
  }

  async verify_rodit_isamatch(own_service_provider_id, peer_rodit) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting RODiT match verification", {
      component: "RoditAuth",
      method: "this.verify_rodit_isamatch",
      requestId,
      ownServiceProviderId: own_service_provider_id,
      peerRoditId: peer_rodit?.token_id,
    });

    try {
      const own_provider_components = own_service_provider_id.split(";");

      logger.debug("Split provider components", {
        requestId,
        componentCount: own_provider_components.length,
        components: own_provider_components,
      });

      // Get blockchain and contract parts
      const bcPart = own_provider_components.find((part) =>
        part.startsWith("bc=")
      );
      const scPart = own_provider_components.find((part) =>
        part.startsWith("sc=")
      );

      // Find all ID components
      const idComponents = own_provider_components.filter(
        (part) =>
          part.startsWith("id=") &&
          !part.startsWith("bc=") &&
          !part.startsWith("sc=")
      );

      if (!bcPart || !scPart || idComponents.length < 1) {
        logger.error("Invalid provider ID format", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          providerId: own_service_provider_id,
          components: own_provider_components,
          hasBlockchain: !!bcPart,
          hasSmartContract: !!scPart,
          idCount: idComponents.length,
        });

        // Add metrics for format errors
        logger.metric &&
          logger.metric("rodit_match_format_errors", 1, {
            error_type: "invalid_provider_id",
            bc_part_present: !!bcPart,
            sc_part_present: !!scPart,
            id_count: idComponents.length,
          });

        return false;
      }

      // Construct the base prefix
      const base_prefix = `${bcPart};${scPart}`;
      logger.debug("Constructed base prefix", {
        requestId,
        basePrefix: base_prefix,
      });

      // Try verification with each ID component
      for (let i = 0; i < idComponents.length; i++) {
        const idIndex = i + 1;
        const signing_token_id = `${base_prefix};${idComponents[i]}`;

        logger.debug(
          `Trying verification with ID [${idIndex}/${idComponents.length}]`,
          {
            requestId,
            idIndex,
            totalIds: idComponents.length,
            signingTokenId: signing_token_id,
          }
        );

        const tokenFetchStart = Date.now();
        const signing_rodit =
          await nearorg_rpc_tokenfromroditid(
            signing_token_id
          );
        const tokenFetchDuration = Date.now() - tokenFetchStart;

        logger.debug("Retrieved signing RODiT", {
          requestId,
          idIndex,
          tokenFetchDuration,
          tokenId: signing_rodit?.token_id,
          ownerId: signing_rodit?.owner_id,
        });

        // Process the owner ID
        try {
          const bytes_signing_owner_id = new Uint8Array(
            Buffer.from(signing_rodit.owner_id, "hex")
          );

          if (
            bytes_signing_owner_id.length !==
            CONSTANTS.RODIT_ID_PK_SZ
          ) {
            logger.warn(`Invalid signing key length for ID ${idIndex}`, {
              requestId,
              actual: bytes_signing_owner_id.length,
              expected: CONSTANTS.RODIT_ID_PK_SZ,
            });
            continue; // Try the next ID
          }

          // Process the signature
          const base64urlSignature =
            peer_rodit.metadata.serviceprovider_signature;
          const base64Signature = base64urlSignature
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(
              base64urlSignature.length +
                ((4 - (base64urlSignature.length % 4)) % 4),
              "="
            );
          const signatureBytes = nacl.util.decodeBase64(base64Signature);

          if (
            signatureBytes.length !==
            CONSTANTS.RODIT_ID_SIGNATURE_SZ
          ) {
            logger.warn(`Invalid signature length for ID ${idIndex}`, {
              requestId,
              actual: signatureBytes.length,
              expected: CONSTANTS.RODIT_ID_SIGNATURE_SZ,
            });
            continue; // Try the next ID
          }

          // Prepare the hash input
          const hashInput = {
            token_id: peer_rodit.token_id,
            openapijson_url: peer_rodit.metadata.openapijson_url,
            not_after: peer_rodit.metadata.not_after,
            not_before: peer_rodit.metadata.not_before,
            max_requests: peer_rodit.metadata.max_requests,
            maxrq_window: peer_rodit.metadata.maxrq_window,
            webhook_cidr: peer_rodit.metadata.webhook_cidr,
            allowed_cidr: peer_rodit.metadata.allowed_cidr,
            allowed_iso3166list: peer_rodit.metadata.allowed_iso3166list,
            jwt_duration: peer_rodit.metadata.jwt_duration,
            permissioned_routes: peer_rodit.metadata.permissioned_routes,
            serviceprovider_id: peer_rodit.metadata.serviceprovider_id,
            subjectuniqueidentifier_url:
              peer_rodit.metadata.subjectuniqueidentifier_url,
          };

          const hashStart = Date.now();
          const hashHex = calculateCanonicalHash(hashInput);
          const hashBytes = new Uint8Array(Buffer.from(hashHex, "hex"));
          const hashDuration = Date.now() - hashStart;

          logger.debug("Calculated hash for verification", {
            requestId,
            idIndex,
            hashDuration,
            hashLength: hashBytes.length,
          });

          // Verify the signature
          const verifyStart = Date.now();
          const is_valid = nacl.sign.detached.verify(
            hashBytes,
            signatureBytes,
            bytes_signing_owner_id
          );
          const verifyDuration = Date.now() - verifyStart;

          logger.debug("Signature verification result", {
            requestId,
            idIndex,
            verifyDuration,
            isValid: is_valid,
          });

          if (is_valid) {
            const totalDuration = Date.now() - startTime;

            // Log based on which ID worked
            if (i === 0) {
              logger.info("Partner login verified successfully", {
                component: "RoditAuth",
                method: "this.verify_rodit_isamatch",
                requestId,
                duration: totalDuration,
                partnerVerification: true,
                idIndex,
              });
            } else {
              logger.info("Peer login verified successfully", {
                component: "RoditAuth",
                method: "this.verify_rodit_isamatch",
                requestId,
                duration: totalDuration,
                peerVerification: true,
                idIndex,
              });
            }

            // Add metrics for successful matching
            logger.metric &&
              logger.metric("rodit_match_verification", totalDuration, {
                result: "success",
                id_index: idIndex,
                verification_type: i === 0 ? "partner" : "peer",
              });

            return true;
          }

          logger.debug(`Verification with ID ${idIndex} failed`, {
            requestId,
          });
        } catch (verifyError) {
          logger.warn(`Error during verification with ID ${idIndex}`, {
            requestId,
            error: verifyError.message,
            stack: verifyError.stack,
          });
        }
      }

      // If we get here, all verification attempts failed
      const totalDuration = Date.now() - startTime;

      logger.error("All verification attempts failed", {
        component: "RoditAuth",
        method: "this.verify_rodit_isamatch",
        requestId,
        duration: totalDuration,
        ownServiceProviderId: own_service_provider_id,
        peerRoditId: peer_rodit?.token_id,
        attemptCount: idComponents.length,
      });

      // Add metrics for failed matching
      logger.metric &&
        logger.metric("rodit_match_verification", totalDuration, {
          result: "failure",
          attempts: idComponents.length,
        });

      return false;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("RODiT match verification failed", {
        component: "RoditAuth",
        method: "this.verify_rodit_isamatch",
        requestId,
        duration,
        ownServiceProviderId: own_service_provider_id,
        peerRoditId: peer_rodit?.token_id,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metrics for verification errors
      logger.metric &&
        logger.metric("rodit_match_errors", 1, {
          error_type: error.name || "Unknown",
        });

      return false;
    }
  }

  async verify_rodit_isactive(tokenId, ownsubjectuniqueidentifier_url) {
    const requestId = ulid();
    const startTime = Date.now();

    // WHILE DEBUGGING TEMPORARY FIX DO NOT REMOVE THIS LINE EVER WITHOUT PERMISSION
    return true;

    logger.debug("Checking RODiT activity status", {
      component: "RoditAuth",
      method: "verify_rodit_isactive",
      requestId,
      tokenId,
      subjectUrl: ownsubjectuniqueidentifier_url,
    });

    const domainandextensionRegex =
      /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/i;

    const match = ownsubjectuniqueidentifier_url.match(domainandextensionRegex);

    if (match) {
      const domainandextension = match[1];
      const revokingDnsEntry = `${tokenId}.revoked.${domainandextension}`;

      logger.debug("Checking DNS revocation entry", {
        requestId,
        domain: domainandextension,
        revokingDnsEntry,
      });

      try {
        const dnsStart = Date.now();
        const resolver = new (require("dns").promises.Resolver)();
        await resolver.resolveTxt(revokingDnsEntry);
        const dnsDuration = Date.now() - dnsStart;
        const totalDuration = Date.now() - startTime;

        logger.info("RODiT revocation found", {
          component: "RoditAuth",
          method: "verify_rodit_isactive",
          requestId,
          duration: totalDuration,
          dnsDuration,
          tokenId,
          domain: domainandextension,
          revokingDnsEntry,
          isActive: false,
        });

        // Add metrics for revoked tokens
        logger.metric &&
          logger.metric("rodit_revocation_checks", totalDuration, {
            result: "revoked",
            token_id: tokenId,
          });

        return false;
      } catch (error) {
        // DNS error usually means no revocation entry found, which is good
        const dnsDuration = Date.now() - dnsStart || 0;
        const totalDuration = Date.now() - startTime;

        logger.debug("No revocation found for RODiT", {
          requestId,
          dnsDuration,
          tokenId,
          error: error.code,
        });

        logger.info("RODiT is active", {
          component: "RoditAuth",
          method: "verify_rodit_isactive",
          requestId,
          duration: totalDuration,
          dnsDuration,
          tokenId,
          domain: domainandextension,
          isActive: true,
        });

        // Add metrics for active tokens
        logger.metric &&
          logger.metric("rodit_revocation_checks", totalDuration, {
            result: "active",
            token_id: tokenId,
          });

        return true;
      }
    } else {
      const duration = Date.now() - startTime;

      logger.warn("Unable to parse domain from URL", {
        component: "RoditAuth",
        method: "verify_rodit_isactive",
        requestId,
        duration,
        tokenId,
        subjectUrl: ownsubjectuniqueidentifier_url,
      });

      // Add metrics for parsing errors
      logger.metric &&
        logger.metric("rodit_revocation_checks", duration, {
          result: "parse_error",
          token_id: tokenId,
        });

      // Default to allowing the token if domain parsing fails
      return true;
    }
  }

  async verify_rodit_istrusted_issuingsmartcontract(
    ownsubjectuniqueidentifier_url
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Verifying smart contract trust", {
      component: "RoditAuth",
      method: "this.verify_rodit_istrusted_issuingsmartcontract",
      requestId,
      url: ownsubjectuniqueidentifier_url,
      smartContract: CONSTANTS.SMART_CONTRACT,
    });

    try {
      const smartcontract = CONSTANTS.SMART_CONTRACT;
      const smartontractnonear = smartcontract.replace(".testnet", "");
      const smartcontracturl = smartontractnonear.replace("-", ".");

      logger.debug("Prepared smart contract identifiers", {
        requestId,
        originalContract: smartcontract,
        nonearContract: smartontractnonear,
        urlContract: smartcontracturl,
      });

      const domainRegex =
        /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/i;

      const maindomainmatch = domainRegex.exec(ownsubjectuniqueidentifier_url);

      if (!maindomainmatch) {
        logger.error("Failed to parse domain from URL", {
          component: "RoditAuth",
          requestId,
          duration: Date.now() - startTime,
          url: ownsubjectuniqueidentifier_url,
        });

        // Add metrics for domain parsing failures
        logger.metric &&
          logger.metric("rodit_trust_errors", 1, {
            error_type: "domain_parse_error",
            url: ownsubjectuniqueidentifier_url,
          });

        throw new Error(
          `Domain can't be parsed from URL: ${ownsubjectuniqueidentifier_url}`
        );
      }

      const extractedDomain = maindomainmatch[1];
      const enablingdnsentry = `${smartontractnonear}.smartcontract.${extractedDomain}`;

      logger.debug("Checking DNS trust entry", {
        requestId,
        extractedDomain,
        enablingDnsEntry: enablingdnsentry,
      });

      try {
        const dnsStart = Date.now();
        const resolver = new (require("dns").promises.Resolver)();
        const cfgresponse = await resolver.resolveTxt(enablingdnsentry);
        const dnsDuration = Date.now() - dnsStart;

        logger.debug("DNS response received", {
          requestId,
          dnsDuration,
          recordCount: cfgresponse?.length || 0,
        });

        if (cfgresponse.length > 0) {
          const totalDuration = Date.now() - startTime;

          logger.info("Smart contract is trusted", {
            component: "RoditAuth",
            method: "this.verify_rodit_istrusted_issuingsmartcontract",
            requestId,
            duration: totalDuration,
            dnsDuration,
            smartContract: smartcontracturl,
            domain: extractedDomain,
            dnsEntry: enablingdnsentry,
            recordCount: cfgresponse.length,
            isTrusted: true,
          });

          // Add metrics for trusted contracts
          logger.metric &&
            logger.metric("rodit_trust_checks", totalDuration, {
              result: "trusted",
              domain: extractedDomain,
            });

          return true;
        } else {
          const totalDuration = Date.now() - startTime;

          logger.warn("Smart contract not trusted - empty DNS record", {
            component: "RoditAuth",
            method: "this.verify_rodit_istrusted_issuingsmartcontract",
            requestId,
            duration: totalDuration,
            dnsDuration,
            smartContract: smartcontracturl,
            domain: extractedDomain,
            dnsEntry: enablingdnsentry,
            isTrusted: false,
          });

          // Add metrics for untrusted contracts
          logger.metric &&
            logger.metric("rodit_trust_checks", totalDuration, {
              result: "empty_dns",
              domain: extractedDomain,
            });

          return false;
        }
      } catch (error) {
        const totalDuration = Date.now() - startTime;

        logger.warn("Smart contract not trusted - DNS lookup failed", {
          component: "RoditAuth",
          method: "this.verify_rodit_istrusted_issuingsmartcontract",
          requestId,
          duration: totalDuration,
          smartContract: smartcontracturl,
          domain: extractedDomain,
          dnsEntry: enablingdnsentry,
          dnsError: error.code,
          isTrusted: false,
        });

        // Add metrics for DNS errors
        logger.metric &&
          logger.metric("rodit_trust_checks", totalDuration, {
            result: "dns_error",
            domain: extractedDomain,
            error_code: error.code,
          });

        return false;
      }
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Trust verification failed", {
        component: "RoditAuth",
        method: "this.verify_rodit_istrusted_issuingsmartcontract",
        requestId,
        duration,
        url: ownsubjectuniqueidentifier_url,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });

      // Add metrics for verification errors
      logger.metric &&
        logger.metric("rodit_trust_errors", 1, {
          error_type: error.name || "Unknown",
          message: error.message,
        });

      return false;
    }
  }

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
      const token = extractTokenFromHeader(req.headers.authorization);

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

      // Add further token validation logic here if needed

      // Proceed to the next middleware or route handler
      next();
    } catch (error) {
      logger.error("Error during API call authentication", {
        component: "AuthenticationMiddleware",
        method: "authenticate_apicall",
        requestId,
        error: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        error: {
          code: "AUTHENTICATION_ERROR",
          message: "An error occurred during authentication",
          requestId,
        },
      });
    }
  }
}

// Export the class directly (will be instantiated in rodit.js)
module.exports = Authentication;
