/**
 * Authentication service for RODiT authentication
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");
const nacl = require("tweetnacl");
const { Resolver } = require("dns").promises;
const { calculateCanonicalHash, unixTimeToDateString } = require("../utils");
// Import specific functions to avoid circular dependencies
const { generate_jwt_token } = require("./tokenservice");
const { 
  nearorg_rpc_timestamp, 
  nearorg_rpc_tokenfromroditid, 
  nearorg_rpc_fetchpublickeybytes,
  RODiT,
  PayloadNEP413,
  PayloadNEP413Schema,
  CONSTANTS,
} = require("../blockchain/blockchainservice");

/**
 * Authenticates a client using RODiT credentials and generates a JWT token
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Object} - JSON response with token or error
 */
async function login_client(req, res) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.info("Client login request received", {
    component: "RoditAuth",
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
      component: "RoditAuth",
      method: "login_client",
      requestId,
      roditId: peer_roditid,
      hasTimestamp: !!peer_timestamp,
      hasSignature: !!roditid_base64url_signature,
    });

    if (!peer_roditid || !peer_timestamp || !roditid_base64url_signature) {
      const duration = Date.now() - startTime;

      logger.warn("Missing required login parameters", {
        component: "RoditAuth",
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
        component: "RoditAuth",
        success: false,
        error: "MISSING_PARAMETERS",
      });
      logger.metric("failed_login_attempts_total", 1, {
        component: "RoditAuth",
        reason: "MISSING_PARAMETERS",
      });

      return res.status(400).json({
        message: "Error 100: Missing RODiT ID, Signature or Timestamp",
        requestId,
      });
    }

    try {
      logger.debug("Retrieving server configuration", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
      });

      // Import stateManager only when needed to avoid circular dependencies
      const stateManager = require("../blockchain/statemanager");
      const config_own_rodit = await stateManager.getConfigOwnRodit();

      if (!config_own_rodit) {
        const duration = Date.now() - startTime;

        logger.error("Server configuration not initialized", {
          component: "RoditAuth",
          method: "login_client",
          requestId,
          duration,
          errorCode: "CONFIG_NOT_INITIALIZED",
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_attempt_duration_ms", duration, {
          component: "RoditAuth",
          success: false,
          error: "CONFIG_NOT_INITIALIZED",
        });
        logger.metric("failed_login_attempts_total", 1, {
          component: "RoditAuth",
          reason: "CONFIG_NOT_INITIALIZED",
        });

        throw new Error("Error 0112: Server configuration not initialized");
      }

      logger.debug("Verifying peer RODiT credentials", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        roditId: peer_roditid,
      });

      // Create a modified request object with the parameters for backward compatibility
      const modifiedReq = {
        ...req,
        id: requestId,
        body: {
          ...req.body,
          roditid: peer_roditid,
          timestamp: peer_timestamp,
          roditid_base64url_signature: roditid_base64url_signature
        }
      };

      // Add detailed logging of both the original and modified request
      logger.debug("Original request body", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        originalBodyKeys: Object.keys(req.body),
        originalHasRoditId: !!req.body.roditid,
        originalHasTimestamp: !!req.body.timestamp,
        originalHasSignature: !!req.body.signature,
        originalHasRoditSignature: !!req.body.roditid_base64url_signature,
        extractedPeerRoditId: peer_roditid,
        extractedPeerTimestamp: peer_timestamp,
        extractedSignatureLength: roditid_base64url_signature?.length,
      });

      logger.debug("Modified request body", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        modifiedBodyKeys: Object.keys(modifiedReq.body),
        modifiedHasRoditId: !!modifiedReq.body.roditid,
        modifiedHasTimestamp: !!modifiedReq.body.timestamp,
        modifiedHasSignature: !!modifiedReq.body.signature,
        modifiedHasRoditSignature: !!modifiedReq.body.roditid_base64url_signature,
      });

      const result = await verify_peerrodit_getrodit(
        peer_roditid,
        peer_timestamp,
        roditid_base64url_signature,
        config_own_rodit
      );
      const { peer_rodit, goodrodit: isRoditValid } = result;

      if (!isRoditValid) {
        const duration = Date.now() - startTime;

        logger.warn("Invalid RODiT credentials", {
          component: "RoditAuth",
          method: "login_client",
          requestId,
          duration,
          roditId: peer_roditid,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("login_attempt_duration_ms", duration, {
          component: "RoditAuth",
          success: false,
          error: "INVALID_CREDENTIALS",
        });
        logger.metric("failed_login_attempts_total", 1, {
          component: "RoditAuth",
          reason: "INVALID_CREDENTIALS",
        });

        return res.status(401).json({
          message:
            "Error 102: Login attempt failed: Invalid RODiT ID or Signature",
          requestId,
        });
      }

      logger.debug("Generating JWT token", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        roditId: peer_rodit.token_id,
      });

      const token = await generate_jwt_token(
        peer_rodit,
        peer_timestamp,
        config_own_rodit.own_rodit,
        config_own_rodit.own_rodit_bytes_private_key
      );

      const duration = Date.now() - startTime;
      logger.info("Login successful", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        duration,
        roditId: peer_rodit.token_id,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("login_attempt_duration_ms", duration, {
        component: "RoditAuth",
        success: true,
      });
      logger.metric("successful_logins_total", 1, {
        component: "RoditAuth",
      });

      // Set the token in the response header
      res.setHeader('New-Token', token);

      return res.json({
        token,
        requestId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Login authentication failed", {
        component: "RoditAuth",
        method: "login_client",
        requestId,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("login_attempt_duration_ms", duration, {
        component: "RoditAuth",
        success: false,
        error: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("failed_login_attempts_total", 1, {
        component: "RoditAuth",
        reason: error.code || "UNKNOWN_ERROR",
      });

      return res.status(401).json({
        message: `Error 105: Login attempt failed: ${error.message}`,
        requestId,
      });
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error("Unexpected error in login process", {
      component: "RoditAuth",
      method: "login_client",
      requestId,
      duration,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      message: "Internal server error during login process",
      requestId
    });
  }
}

async function verify_rodit_ownership(
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
      signatureValue: peerroditid_base64url_signature?.substring(0, 20) + '...',
    });

    try {
      // DO NOT DELETE THE FOLLOWING COMMENT
      /* Maybe for NEP413 compatibility, the following line added "NEAR" before peerroditid */
      
      // Match legacy implementation exactly
      const timeString = await unixTimeToDateString(peertimestamp);
      const roditidandtimestamp = new TextEncoder().encode(
        peerroditid + timeString
      );

      logger.debug("Encoded roditid and timestamp", {
        component: "RoditAuth",
        method: "verify_rodit_ownership",
        requestId,
        timeString,
        peerRoditId: peerroditid,
        combinedString: peerroditid + timeString,
        bufferLength: roditidandtimestamp.length,
        bufferHex: Buffer.from(roditidandtimestamp).toString('hex').substring(0, 64) + '...',
      });

      // Check if signature is defined before proceeding
      if (!peerroditid_base64url_signature) {
        logger.error("Missing signature in authentication request", {
          component: "RoditAuth",
          method: "verify_rodit_ownership",
          requestId,
          peerRoditId: peerroditid,
        });
        throw new Error("Missing signature in authentication request");
      }

      const bytes_ed25519_signature = new Uint8Array(
        Buffer.from(peerroditid_base64url_signature, "base64url")
      );
      
      logger.debug("Decoded signature using base64url", {
        component: "RoditAuth",
        method: "verify_rodit_ownership",
        requestId,
        signatureLength: bytes_ed25519_signature.length,
        signatureHex: Buffer.from(bytes_ed25519_signature).toString('hex').substring(0, 64) + '...',
        expectedLength: 64, // Ed25519 signatures should be 64 bytes
      });

      const peer_bytes_ed25519_public_key =
        await nearorg_rpc_fetchpublickeybytes(
          peer_rodit.owner_id
        );

      logger.debug("Retrieved public key", {
        component: "RoditAuth",
        method: "verify_rodit_ownership",
        requestId,
        ownerId: peer_rodit.owner_id,
        keyLength: peer_bytes_ed25519_public_key?.length || 0,
        keyHex: peer_bytes_ed25519_public_key ? Buffer.from(peer_bytes_ed25519_public_key).toString('hex') : 'null',
        expectedLength: 32, // Ed25519 public keys should be 32 bytes
      });

      // Add more detailed debugging for verification inputs
      logger.debug("Verification inputs", {
        component: "RoditAuth",
        method: "verify_rodit_ownership",
        requestId,
        messageLength: roditidandtimestamp.length,
        messageContent: peerroditid + timeString,
        signatureLength: bytes_ed25519_signature.length,
        publicKeyLength: peer_bytes_ed25519_public_key?.length,
        messageHex: Buffer.from(roditidandtimestamp).toString('hex'),
        signatureHex: Buffer.from(bytes_ed25519_signature).toString('hex'),
        publicKeyHex: peer_bytes_ed25519_public_key ? Buffer.from(peer_bytes_ed25519_public_key).toString('hex') : 'null',
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

 async function verify_rodit_ownership_withnep413(
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
 async function send_webhook(event, data, isError = false, req = null) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting webhook delivery", {
      component: "RoditAuth",
      method: "send_webhook",
      requestId,
      event,
      isError,
      dataSize:
        typeof data === "object" ? JSON.stringify(data).length : "unknown",
    });

    try {
      // Get the configuration from state manager
      const config_own_rodit = await stateManager.getConfigOwnRodit();
      
      // Check if webhook configuration is available
      if (
        !config_own_rodit ||
        !config_own_rodit.own_rodit.metadata.webhook_url
      ) {
        const duration = Date.now() - startTime;

        logger.warn("Webhook configuration missing", {
          component: "RoditAuth",
          method: "send_webhook",
          requestId,
          duration,
          hasConfig: !!config_own_rodit,
          hasOwnRodit: !!config_own_rodit?.own_rodit,
          hasMetadata: !!config_own_rodit?.own_rodit?.metadata,
        });

        // Emit metrics for Grafana dashboards
        logger.metric &&
          logger.metric("webhook_delivery_duration_ms", duration, {
            component: "RoditAuth",
            success: false,
            event,
            error: "WEBHOOK_CONFIG_ERROR",
          });
        logger.metric &&
          logger.metric("webhook_delivery_failures_total", 1, {
            component: "RoditAuth",
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
      let jwt_token = stateManager.getJwtToken();
      if (!jwt_token) {
        // If there's no token, we need to login first
        logger.debug("No JWT token available, attempting login", {
          component: "RoditAuth",
          method: "send_webhook",
          requestId,
        });

        try {
          // Login to get a token
          const loginResult = await login_server(
            config_own_rodit.own_rodit
          );

          if (loginResult && loginResult.jwt_token) {
            jwt_token = loginResult.jwt_token;
            await stateManager.setJwtToken(jwt_token);

            logger.info("Successfully obtained JWT token for webhook", {
              component: "RoditAuth",
              method: "send_webhook",
              requestId,
            });
          } else {
            logger.error("Failed to obtain JWT token for webhook", {
              component: "RoditAuth",
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
            component: "RoditAuth",
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
          component: "RoditAuth",
          method: "send_webhook",
          requestId,
          webhookSource: "peer_jwt",
          webhookUrl,
        });
      } else {
        // Fallback to config
        webhookUrl = config_own_rodit.own_rodit.metadata.webhook_url;
        logger.debug("Using webhook URL from own RODiT config", {
          component: "RoditAuth",
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
        component: "RoditAuth",
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
        component: "RoditAuth",
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
        component: "RoditAuth",
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
          component: "RoditAuth",
        });

      const signature_hex_ofpayload =
        Buffer.from(signature_ofpayload).toString("hex");

      logger.debug("Sending webhook request", {
        component: "RoditAuth",
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
        component: "RoditAuth",
        success: response.ok,
        status: response.status,
        event,
      });

      if (!response.ok) {
        const duration = Date.now() - startTime;

        logger.error("Webhook delivery failed", {
          component: "RoditAuth",
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
          component: "RoditAuth",
          success: false,
          event,
          error: "HTTP_ERROR",
          status: response.status,
        });
        logger.metric("webhook_delivery_failures_total", 1, {
          component: "RoditAuth",
          reason: "HTTP_ERROR",
          status: response.status,
          event,
        });

        throw new Error(`HTTP error! status: ${response.status}`);
      }

      await response.text();

      const duration = Date.now() - startTime;
      logger.info("Webhook delivered successfully", {
        component: "RoditAuth",
        method: "send_webhook",
        requestId,
        duration,
        event,
        webhookUrl: formattedWebhookUrl,
        status: response.status,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_delivery_duration_ms", duration, {
        component: "RoditAuth",
        success: true,
        event,
      });
      logger.metric("successful_webhook_deliveries_total", 1, {
        component: "RoditAuth",
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
        component: "RoditAuth",
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
        component: "RoditAuth",
        success: false,
        event,
        error: error.constructor.name,
      });
      logger.metric("webhook_delivery_errors_total", 1, {
        component: "RoditAuth",
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
 async function authenticate_webhook(
    payload,
    signature_hex_ofpayload,
    timestamp,
    peer_rodit_owner_id
  ) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting webhook authentication", {
      component: "RoditAuth",
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
          component: "RoditAuth",
          method: "authenticate_webhook",
          requestId,
          duration,
          timestampAge: (currentTime - parsedTimestamp) / 1000,
          threshold: timeThreshold / 1000,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("webhook_authentication_duration_ms", duration, {
          component: "RoditAuth",
          success: false,
          reason: "TIMESTAMP_EXPIRED",
        });
        logger.metric("webhook_authentication_failures_total", 1, {
          component: "RoditAuth",
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
        component: "RoditAuth",
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
        component: "RoditAuth",
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
        component: "RoditAuth",
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
          component: "RoditAuth",
          success: isValid,
        }
      );

      if (!isValid) {
        const duration = Date.now() - startTime;

        logger.warn("Webhook authentication failed - invalid signature", {
          component: "RoditAuth",
          method: "authenticate_webhook",
          requestId,
          duration,
          verificationDuration,
        });

        // Emit metrics for Grafana dashboards
        logger.metric("webhook_authentication_duration_ms", duration, {
          component: "RoditAuth",
          success: false,
          reason: "INVALID_SIGNATURE",
        });
        logger.metric("webhook_authentication_failures_total", 1, {
          component: "RoditAuth",
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
        component: "RoditAuth",
        method: "authenticate_webhook",
        requestId,
        duration,
        verificationDuration,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_authentication_duration_ms", duration, {
        component: "RoditAuth",
        success: true,
      });
      logger.metric("successful_webhook_authentications_total", 1, {
        component: "RoditAuth",
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
        component: "RoditAuth",
        method: "authenticate_webhook",
        requestId,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("webhook_authentication_duration_ms", duration, {
        component: "RoditAuth",
        success: false,
        error: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("webhook_authentication_errors_total", 1, {
        component: "RoditAuth",
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
   * Verify and get a peer RODiT
   *
   * @param {string} peerroditid - Peer RODiT ID
   * @param {number} peertimestamp - Peer timestamp
   * @param {string} peerroditid_base64url_signature - Base64URL signature
   * @param {Object} own_rodit - Own RODiT object
   * @returns {Promise<Object>} Verification result with peer RODiT
   */
  async function verify_peerrodit_getrodit(
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
      const peer_rodit = await nearorg_rpc_tokenfromroditid(peerroditid);
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
          method: "verify_peerrodit_getrodit",
          requestId,
          duration: Date.now() - startTime,
          peerRoditId: peerroditid,
        });
        return { peer_rodit: null, goodrodit: false };
      }

      if (!peer_rodit.metadata) {
        logger.error("Peer RODiT missing metadata", {
          component: "RoditAuth",
          method: "verify_peerrodit_getrodit",
          requestId,
          duration: Date.now() - startTime,
          peerRoditId: peerroditid,
          peerRoditOwnerId: peer_rodit.owner_id,
        });
        return { peer_rodit: null, goodrodit: false };
      }

      // Get configuration from state manager if not provided
      const config_own_rodit = own_rodit || await stateManager.getConfigOwnRodit();

      if (!config_own_rodit) {
        logger.error("Server configuration not initialized", {
          component: "RoditAuth",
          method: "verify_peerrodit_getrodit",
          requestId,
          duration: Date.now() - startTime,
        });
        return { peer_rodit: null, goodrodit: false };
      }

      // Verify ownership
      const ownershipStart = Date.now();
      const ownershipVerified = await verify_rodit_ownership(
        peerroditid,
        peertimestamp,
        peerroditid_base64url_signature,
        peer_rodit
      );
      const ownershipDuration = Date.now() - ownershipStart;

      logger.debug("Ownership verification completed", {
        requestId,
        ownershipDuration,
        ownershipVerified,
      });

      if (!ownershipVerified) {
        logger.warn("Invalid signature, aborting RODiT verification", {
          requestId,
          roditId: peerroditid,
        });
        return { peer_rodit, goodrodit: false };
      }

      // Verify match
      const matchStart = Date.now();
      const isaMatch = await verify_rodit_isamatch(
        config_own_rodit.own_rodit.metadata.serviceprovider_id,
        peer_rodit
      );
      const matchDuration = Date.now() - matchStart;

      logger.debug("Match verification completed", {
        requestId,
        matchDuration,
        isaMatch,
      });

      if (!isaMatch) {
        logger.warn("RODiT match verification failed", {
          requestId,
          roditId: peerroditid,
        });
        return { peer_rodit, goodrodit: false };
      }

      // Verify live
      const liveStart = Date.now();
      const isLive = await verify_rodit_islive(
        peer_rodit.metadata.not_after,
        peer_rodit.metadata.not_before
      );
      const liveDuration = Date.now() - liveStart;

      logger.debug("Live verification completed", {
        requestId,
        liveDuration,
        isLive,
      });

      if (!isLive) {
        logger.warn("RODiT live verification failed", {
          requestId,
          roditId: peerroditid,
        });
        return { peer_rodit, goodrodit: false };
      }

      // Verify active
      const activeStart = Date.now();
      const isActive = await verify_rodit_isactive(
        peer_rodit.token_id,
        config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
      );
      const activeDuration = Date.now() - activeStart;

      logger.debug("Active verification completed", {
        requestId,
        activeDuration,
        isActive,
      });

      if (!isActive) {
        logger.warn("RODiT active verification failed", {
          requestId,
          roditId: peerroditid,
        });
        return { peer_rodit, goodrodit: false };
      }

      // Verify trusted
      const trustedStart = Date.now();
      const isTrusted = await verify_rodit_istrusted_issuingsmartcontract(
        config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
      );
      const trustedDuration = Date.now() - trustedStart;

      logger.debug("Trust verification completed", {
        requestId,
        trustedDuration,
        isTrusted,
      });

      if (!isTrusted) {
        logger.warn("RODiT trusted verification failed", {
          requestId,
          roditId: peerroditid,
        });
        return { peer_rodit, goodrodit: false };
      }

      const totalDuration = Date.now() - startTime;

      logger.info("Peer RODiT verification successful", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration: totalDuration,
        peerRoditId: peerroditid,
        peerOwnerId: peer_rodit.owner_id,
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
        });

      return {
        peer_rodit: null,
        goodrodit: false,
        error: `Error in verify_peerrodit_getrodit: ${error.message}`,
      };
    }
  }

// Export the functions directly (following the pattern used in tokenservice.js)
module.exports = {
  login_client,
  verify_rodit_ownership,
  verify_rodit_ownership_withnep413,
  verify_peerrodit_getrodit,
  verify_rodit_isactive,
  verify_rodit_isamatch,
  verify_rodit_islive,
  verify_rodit_istrusted_issuingsmartcontract,
  authenticate_webhook,
  send_webhook
};
