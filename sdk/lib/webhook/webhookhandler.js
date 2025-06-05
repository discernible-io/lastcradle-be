// webhookhandler.js
// Reusable webhook handler for RODiT SDK

const crypto = require("crypto");
const logger = require("../../../config/logger");
const { authenticate_webhook } = require("../auth/authentication");

/**
 * Create a raw body parser middleware specifically for webhook endpoints
 * This preserves the raw body for signature verification
 * @returns {Function} Express middleware
 */
function createRawBodyParser() {
  return (req, res, next) => {
    if (req.headers['content-type'] !== 'application/json') {
      return res.status(415).json({ error: 'Unsupported Media Type. Only application/json is supported.' });
    }
    
    let data = '';
    req.setEncoding('utf8');
    
    req.on('data', (chunk) => {
      data += chunk;
    });
    
    req.on('end', () => {
      // Store the raw body for signature verification
      req.rawBody = data;
      
      // Parse JSON for convenience
      try {
        req.body = JSON.parse(data);
        next();
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON payload' });
      }
    });
  };
}

/**
 * Create middleware to mark webhook routes as not requiring authentication
 * @returns {Function} Express middleware
 */
function createWebhookFlagMiddleware() {
  return (req, res, next) => {
    // Set a flag to indicate this route should bypass authentication checks
    req.isWebhookRoute = true;
    next();
  };
}

/**
 * Create middleware to attach the server's public key to the request
 * @param {Object} stateManager - State manager instance
 * @returns {Function} Express middleware
 */
function createPublicKeyMiddleware(stateManager) {
  return async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const logContext = {
      requestId,
      endpoint: req.path,
      method: req.method,
      headers: Object.keys(req.headers),
      hasSignature: !!req.headers["x-signature"],
      hasTimestamp: !!req.headers["x-timestamp"],
    };

    try {
      // Check if this is a test environment where we should bypass signature verification
      const isTestEnvironment = process.env.NODE_ENV === 'test' || process.env.BYPASS_WEBHOOK_VERIFICATION === 'true';
      
      // Get the peer public key from the state manager
      const peerBase64urlJwkPublicKey = stateManager.getPeerBase64urlJwkPublicKey();
      
      // If the peer public key is not available and we're not in test mode, return an error
      if (!peerBase64urlJwkPublicKey && !isTestEnvironment) {
        logger.warnWithContext("Peer public key not available in state manager", logContext);
        
        // In production, we need the key
        if (process.env.NODE_ENV === 'production') {
          logger.errorWithContext("Peer public key not available in production environment", logContext);
          return res.status(500).json({ error: "Peer public key not available" });
        }
        
        // In development or test, we'll continue without the key and skip verification
        logger.infoWithContext("Continuing without peer public key in non-production environment", {
          ...logContext,
          environment: process.env.NODE_ENV || 'development'
        });
      }
      
      if (peerBase64urlJwkPublicKey) {
        // Log that we're using the peer public key
        logger.infoWithContext("Using peer public key from state manager", {
          ...logContext,
          keyFormat: "JWK",
          keyFound: true
        });
        
        try {
          logger.debugWithContext("Processing peer public key", {
            ...logContext,
            keyLength: peerBase64urlJwkPublicKey ? peerBase64urlJwkPublicKey.length : 0,
            keyFormat: "base64url_encoded_hex"
          });
          
          // The key is already in base64url format and should be decoded directly to bytes
          req.peer_bytes_ed25519_public_key = new Uint8Array(
            Buffer.from(peerBase64urlJwkPublicKey, "base64url")
          );
          req.server_bytes_ed25519_public_key = req.peer_bytes_ed25519_public_key;
          req.server_public_key_base64url = peerBase64urlJwkPublicKey;

          logger.debugWithContext("Processed peer public key", {
            ...logContext,
            keyLength: req.peer_bytes_ed25519_public_key.length,
            keyFormat: "base64url_decoded_to_bytes"
          });
        } catch (jwkError) {
          logger.errorWithContext("Error converting JWK peer public key", {
            ...logContext,
            error: jwkError.message
          });
          return res.status(500).json({ error: "Error processing peer public key" });
        }
      }
      
      next();
    } catch (error) {
      logger.errorWithContext("Error extracting server public key", {
        ...logContext,
        error: error.message,
        stack: error.stack,
      });
      return res.status(500).json({ error: "Server configuration error" });
    }
  };
}

/**
 * Create middleware to authenticate webhook requests
 * @returns {Function} Express middleware
 */
function createWebhookAuthenticationMiddleware() {
  return async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const logContext = {
      requestId,
      endpoint: req.path,
      method: req.method,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.jsonBody || req.body || {}),
      bodySize: req.jsonBody ? JSON.stringify(req.jsonBody).length : 0,
    };

    try {
      const signature_hex_ofpayload = req.headers["x-signature"];
      const timestamp = req.headers["x-timestamp"];
      
      // Use the raw body that was captured by our middleware
      const payload = req.rawBody;
      
      if (!signature_hex_ofpayload || !timestamp || !payload) {
        logger.warnWithContext("Missing required webhook authentication parameters", {
          ...logContext,
          hasSignature: !!signature_hex_ofpayload,
          hasTimestamp: !!timestamp,
          hasPayload: !!payload
        });
        return res.status(400).json({ 
          error: "Missing required authentication parameters",
          code: 'MISSING_AUTH_PARAMS'
        });
      }
      
      // Log the payload hash and signature for debugging
      const payloadHash = crypto
        .createHash("sha256")
        .update(payload)
        .digest("hex");
      
      logger.debug("Webhook payload hash and signature", {
        ...logContext,
        payloadHash: payloadHash,
        payloadWithTimestamp: payload + (timestamp || ''),
        payloadWithTimestampHash: crypto
          .createHash("sha256")
          .update(payload + (timestamp || ''))
          .digest("hex"),
        signature: signature_hex_ofpayload,
        timestamp: timestamp
      });
      
      // Update log context with body info
      if (Array.isArray(req.body)) {
        logContext.bodyIsArray = true;
        logContext.bodyLength = req.body.length;
      } else {
        logContext.bodyIsArray = false;
        logContext.bodyKeys = Object.keys(req.body || {});
      }
      
      logContext.bodySize = payload.length;
      logContext.hasSignature = !!signature_hex_ofpayload;
      logContext.hasTimestamp = !!timestamp;
      
      // Check if we have the server's public key
      if (!req.server_public_key_base64url) {
        // In test environments, we might want to bypass verification
        if (process.env.NODE_ENV === 'test' || process.env.BYPASS_WEBHOOK_VERIFICATION === 'true') {
          logger.warnWithContext("Bypassing webhook authentication in test environment", logContext);
          return next();
        }
        
        logger.errorWithContext("Missing server public key for webhook authentication", logContext);
        return res.status(500).json({ error: "Server configuration error" });
      }
      
      // Authenticate the webhook using the server's public key
      logger.debugWithContext("Authenticating webhook", logContext);
      const publicKeyBase64url = req.server_public_key_base64url;
      
      // Call the authentication function with proper error handling
      let authResult;
      try {
        authResult = await authenticate_webhook(
          payload,
          signature_hex_ofpayload,
          timestamp,
          publicKeyBase64url
        );
      } catch (authError) {
        logger.errorWithContext("Error during webhook authentication", {
          ...logContext,
          error: authError.message,
          stack: authError.stack
        });
        return res.status(500).json({ error: "Webhook authentication error", message: authError.message });
      }

      if (!authResult.isValid) {
        logContext.authError = authResult.error?.message;
        logger.warnWithContext("Invalid webhook signature", {
          ...logContext,
          error: authResult.error?.message,
          code: authResult.error?.code || 'UNKNOWN_ERROR'
        });
        return res.status(401).json({ 
          error: "Invalid webhook signature", 
          message: authResult.error?.message,
          code: authResult.error?.code || 'INVALID_SIGNATURE'
        });
      }

      logger.infoWithContext("Webhook authenticated successfully", {
        ...logContext,
        authDuration: authResult.duration,
        component: "WebhookReceiver"
      });
      
      // Store authentication result for later use
      req.webhookAuthResult = authResult;
      
      next();
    } catch (error) {
      logger.errorWithContext("Error authenticating webhook", {
        ...logContext,
        error: error.message,
        stack: error.stack
      });
      return res.status(500).json({ error: "Webhook authentication error" });
    }
  };
}

/**
 * Process a webhook event and extract its data
 * @param {Object} req - Express request object
 * @param {Object} logContext - Logging context
 * @returns {Object} Extracted event data
 */
function processWebhookEvent(req, logContext = {}) {
  try {
    // Check if the body is valid before attempting to destructure
    if (!req.body || typeof req.body !== 'object') {
      logger.errorWithContext("Invalid webhook payload format", {
        ...logContext,
        component: "WebhookReceiver",
        bodyType: typeof req.body,
        bodyIsNull: req.body === null,
        contentType: req.headers['content-type']
      });
      return { error: "Invalid payload format" };
    }
    
    const { event, data, isError, timestamp: payloadTimestamp, requestId: payloadRequestId } = req.body;
    
    logger.infoWithContext("Processing webhook payload", {
      ...logContext,
      component: "WebhookReceiver",
      event,
      isError,
      payloadTimestamp,
      payloadRequestId,
      dataKeys: data ? Object.keys(data) : [],
      dataType: typeof data,
      dataSize: data ? JSON.stringify(data).length : 0,
      isTest: data && data.test_id ? true : false,
      testId: data && data.test_id ? data.test_id : null
    });

    return {
      event,
      data,
      isError,
      timestamp: payloadTimestamp,
      requestId: payloadRequestId,
      error: null
    };
  } catch (error) {
    logger.warnWithContext("Error processing webhook payload", {
      ...logContext,
      component: "WebhookReceiver",
      error: error.message,
      stack: error.stack
    });
    return { error: error.message };
  }
}

/**
 * Create a complete webhook handler for Express
 * @param {Object} stateManager - State manager instance
 * @param {Object} options - Configuration options
 * @returns {Object} Webhook handler with middleware and utilities
 */
function createWebhookHandler(stateManager, options = {}) {
  const rawBodyParser = createRawBodyParser();
  const webhookFlagMiddleware = createWebhookFlagMiddleware();
  const publicKeyMiddleware = createPublicKeyMiddleware(stateManager);
  const authenticationMiddleware = createWebhookAuthenticationMiddleware();
  
  return {
    // Middleware
    rawBodyParser,
    webhookFlagMiddleware,
    publicKeyMiddleware,
    authenticationMiddleware,
    
    // Utility functions
    processWebhookEvent,
    
    // Combined middleware for easy setup
    middleware: [
      rawBodyParser,
      webhookFlagMiddleware,
      publicKeyMiddleware,
      authenticationMiddleware
    ],
    
    // Helper to apply middleware based on route
    applyMiddleware: (app, express) => {
      // Apply raw body parser only to webhook routes
      app.use((req, res, next) => {
        if (req.path === '/webhook') {
          rawBodyParser(req, res, next);
        } else {
          express.json()(req, res, next);
        }
      });
      
      // Apply webhook flag middleware to webhook routes
      app.use('/webhook', webhookFlagMiddleware);
      
      // Apply public key middleware to webhook routes
      app.use('/webhook', publicKeyMiddleware);
      
      return app;
    }
  };
}

module.exports = {
  createRawBodyParser,
  createWebhookFlagMiddleware,
  createPublicKeyMiddleware,
  createWebhookAuthenticationMiddleware,
  processWebhookEvent,
  createWebhookHandler
};
