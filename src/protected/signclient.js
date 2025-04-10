// Copyright (c) 2024 Cableguard, Inc. All rights reserved.

const config = require("config");
const express = require("express");
const bodyParser = require("body-parser");
const logger = require("../../config/logger");
const {
  roditManager,
  stateManager,
  login_portal,
  send_webhook,
  authenticate_webhook
} = require("../middleware/rodit");

// Configuration constants
const WEBHOOKPORT = config.get("WEBHOOKPORT");

// Set up Express server
const app = express();
app.use(bodyParser.json());

const attachPeerKey = (peer_bytes_ed25519_public_key) => (req, res, next) => {
  req.peer_bytes_ed25519_public_key = peer_bytes_ed25519_public_key;
  next();
};

// Webhook endpoint
app.post(
  "/webhook",
  async (req, res, next) => {
    try {
      // Get peer key from state manager
      const config = await stateManager.getConfigOwnRodit();
      if (!config || !config.peer_rodit || !config.peer_rodit.bytes_ed25519_public_key) {
        throw new Error("Peer public key not available");
      }
      req.peer_bytes_ed25519_public_key = config.peer_rodit.bytes_ed25519_public_key;
      next();
    } catch (error) {
      logger.error(`Error getting peer key: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  },
  async (req, res) => {
    try {
      const signature_hex_ofpayload = req.headers["x-signature"];
      const timestamp = req.headers["x-timestamp"];
      const payload = JSON.stringify(req.body);

      // Authenticate the webhook
      const authResult = authenticate_webhook(
        payload,
        signature_hex_ofpayload,
        timestamp,
        req.peer_bytes_ed25519_public_key
      );

      if (!authResult.isValid) {
        throw new Error(authResult.error.message);
      }

      // If we've made it here, the signature is valid
      const { event, data, isError } = req.body;
      logger.info(
        `Info: Received authenticated webhook: ${event}, Request ID: ${authResult.requestId}`
      );
      logger.info("Data:", data);

      res.sendStatus(200);
    } catch (error) {
      logger.error(`Error processing webhook: ${error.message}`);
      res.status(400).json({ error: error.message });
    }
  }
);

// Client-side functions
async function fetchWithErrorHandling(url, options) {
  try {
    // Get the JWT token from the state manager
    const jwt_token = stateManager.getJwtToken();
    
    // Add the current token to the request headers
    if (jwt_token) {
      options.headers = {
        ...options.headers,
        Authorization: `Bearer ${jwt_token}`,
      };
    }

    const response = await fetch(url, options);

    // Check for a new token in the response headers
    const newToken = response.headers.get("New-Token");
    if (newToken) {
      // Update JWT token in state manager
      await stateManager.setJwtToken(newToken);
      try {
        // Use state manager to validate the token
        const config = await stateManager.getConfigOwnRodit();
        if (!config) {
          logger.error("Error: Client configuration not initialized");
          return;
        }
        const result = await roditManager.validateJwtToken(newToken);
        if (!result.isValid) {
          throw new Error(`Token validation failed: ${result.error.message}`);
        }
      } catch (validationError) {
        throw new Error(
          `Error 139: Server validation failed: ${validationError.message}`
        );
      }
      console.debug("Info: Received an updated JWT token");
    }

    // Parse the response as JSON
    const responseData = await response.json();

    if (!response.ok) {
      // Check if it's a rate limiting error
      if (
        response.status === 429 &&
        responseData.error === "RateLimitExceeded"
      ) {
        const retryAfter = parseInt(
          response.headers.get("Retry-After") || "60",
          10
        );
        return {
          error: "RateLimitExceeded",
          message: responseData.message,
          retryAfter,
          maxRequests: responseData.maxRequests,
          windowMinutes: responseData.windowMinutes,
        };
      }

      // For other errors, throw with details
      throw new Error(
        `Error: Request failed: ${
          response.statusText
        }, Details: ${JSON.stringify(responseData)}`
      );
    }

    return responseData;
  } catch (error) {
    logger.error(`Error: fetchWithErrorHandling: ${error.message}`);

    // If the error is due to JSON parsing (i.e., the response wasn't JSON)
    if (error instanceof SyntaxError && error.message.includes("JSON")) {
      return {
        error: "Error: InvalidResponse",
        message: "The server returned an invalid response",
      };
    }

    return {
      error: "RequestFailed",
      message: error.message,
    };
  }
}

// SignPortal operation
async function signPortalRodit(apiendpoint, tamperproofedValues, mintingfee, mintingfeeaccount) {
  console.info("Info: Sending signportal request...");
  
  const headers = {
    "Content-Type": "application/json",
  };
  
  const requestBody = {
    tamperproofedValues,
    mintingfee,
    mintingfeeaccount
  };
  
  try {
    const result = await fetchWithErrorHandling(`${apiendpoint}/api/portal/signportal`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    
    if (result.error) {
      logger.error(`Error in signportal operation: ${result.message}`);
      if (result.error === "RateLimitExceeded") {
        logger.info(
          `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`
        );
        logger.info(
          `Limit: ${result.maxRequests} requests per ${result.windowMinutes} minutes.`
        );
      }
      return null;
    }
    
    logger.info("Info: signportal operation successful:", result);
    return result;
  } catch (error) {
    logger.error(`Error during signportal operation: ${error.message}`);
    return null;
  }
}

async function sampleSignClient() {
  try {
    // Initialize vault using the manager
    await roditManager.initializeVault();
    
    // Initialize RODIT configuration with the "server" namespace
    await roditManager.initializeRoditConfig("server");
    
    // Get configuration from state manager
    const config = await stateManager.getConfigOwnRodit();
    
    if (!config) {
      throw new Error("Failed to initialize RODiT configuration");
    }

    const loginResult = await login_portal(config.own_rodit,1443);
    
    // Store JWT token in the state manager
    if (loginResult.jwt_token) {
      await stateManager.setJwtToken(loginResult.jwt_token);

      // Define sample tamperproofed values
      const sampleTamperproofedValues = {
        openapijson_url: "https://api.example.com/openapi.json",
        not_after: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year from now
        not_before: new Date().toISOString(),
        max_requests: 100,
        maxrq_window: 60,
        webhook_cidr: "10.0.0.0/24",
        allowed_cidr: "0.0.0.0/0",
        allowed_iso3166list: JSON.stringify(["US", "CA", "UK"]),
        jwt_duration: 3600,
        permissioned_routes: JSON.stringify(["/api/data", "/api/users"]),
        subjectuniqueidentifier_url: "https://example.com/identifier"
      };
      
      // Define sample minting fee information
      const sampleMintingFee = "0.001";
      const sampleMintingFeeAccount = "0x1234567890abcdef";

      // Call signPortal operation
      const signResult = await signPortalRodit(
        loginResult.apiendpoint,
        sampleTamperproofedValues,
        sampleMintingFee,
        sampleMintingFeeAccount
      );

      if (signResult) {
        logger.info("Sign operation successful. RODIT token ID:", signResult.token_id);
      } else {
        logger.error("Sign operation failed");
      }

    } else {
      logger.error("Error: Failed to obtain JWT token");
    }
  } catch (error) {
    logger.error(`Error: Sample client function error: ${error.message}`);
  }
}

// Start the server and run the client
const server = app.listen(WEBHOOKPORT, async () => {
  console.info(`Webhook server listening on port ${WEBHOOKPORT}`);

  try {
    // Run the client operations
    await sampleSignClient();
    console.info("Server ready to accept webhook requests");
  } catch (error) {
    console.error("Error during server startup:", error);
    process.exit(1);
  }
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

module.exports = app;