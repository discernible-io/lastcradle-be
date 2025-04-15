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
  fetchWithErrorHandling,
  authenticate_webhook,
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
      if (
        !config ||
        !config.peer_rodit ||
        !config.peer_rodit.bytes_ed25519_public_key
      ) {
        throw new Error("Peer public key not available");
      }
      req.peer_bytes_ed25519_public_key =
        config.peer_rodit.bytes_ed25519_public_key;
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

// SignPortal operation
async function signPortalRodit(
  apiendpoint,
  tamperproofedValues,
  mintingfee,
  mintingfeeaccount
) {
  logger.info("Info: Sending signportal request...");
  const current_jwt_token = stateManager.getJwtToken();
  logger.info(`JWT Token for API call: ${current_jwt_token ? 'Token exists' : 'Token missing'}`);

  const requestBody = {
    tamperproofedValues,
    mintingfee,
    mintingfeeaccount,
  };

  try {
    // Just provide the Content-Type, let fetchWithErrorHandling add the Authorization
    const result = await fetchWithErrorHandling(
      `${apiendpoint}/api/portal/signportal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (result.error) {
      // Error handling remains the same
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

    const loginResult = await login_portal(config.own_rodit, 8443);

    // Store JWT token in the state manager
    if (loginResult.jwt_token) {
      await stateManager.setJwtToken(loginResult.jwt_token);
      logger.info(`JWT Token stored after login: ${loginResult.jwt_token ? 'loginToken exists' : 'Token missing'}`);
      // Define sample values that match what contract.js expects
      const tamperproofedValues = {
        openapijson_url: "https://api.example.com/openapi.json",
        not_after: new Date(
          Date.now() + 365 * 24 * 60 * 60 * 1000
        ).toISOString(),
        not_before: new Date().toISOString(),
        max_requests: 100,
        maxrq_window: 60,
        webhook_cidr: "10.0.0.0/24",
        allowed_cidr: "0.0.0.0/0",
        allowed_iso3166list: JSON.stringify(["US", "CA", "UK"]),
        jwt_duration: 3600,
        permissioned_routes: JSON.stringify(["/api/data", "/api/users"]),
        subjectuniqueidentifier_url: "https://example.com/identifier",
      };

      // Use signPortalRodit which now matches the contract.js approach
      const signResult = await signPortalRodit(
        loginResult.apiendpoint,
        tamperproofedValues,
        "0.001", // mintingfee
        "0x1234567890abcdef" // mintingfeeaccount
      );

      if (signResult) {
        logger.info(
          "Sign operation successful. RODIT token ID:",
          signResult.token_id
        );
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
  logger.info(`Webhook server listening on port ${WEBHOOKPORT}`);

  try {
    // Run the client operations
    await sampleSignClient();
    logger.info("Server ready to accept webhook requests");
  } catch (error) {
    logger.error("Error during server startup:", error);
    process.exit(1);
  }
});

process.on("SIGINT", () => {
  logger.log("SIGINT signal received: closing HTTP server");
  server.close(() => {
    logger.log("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  logger.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    logger.log("HTTP server closed");
    process.exit(0);
  });
});

module.exports = app;
