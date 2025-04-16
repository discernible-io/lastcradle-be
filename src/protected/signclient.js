// In the protected/signclient.js file
const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const logger = require("../../config/logger");
const {
  roditManager,
  stateManager,
  login_portal,
  send_webhook,
  getPortalUrl,
  fetchWithErrorHandling,
} = require("../middleware/rodit");

async function signPortalRodit(
  port,
  tamperproofedValues,
  mintingfee,
  mintingfeeaccount
) {
  const requestId = ulid();
  logger.info(`Sending signportal request - Request ID: ${requestId}`);

  // Get API endpoint using the getPortalUrl function
  const apiendpoint = getPortalUrl(
    tamperproofedValues.serviceprovider_id,
    port
  );

  const current_jwt_token = stateManager.getJwtToken();
  const requestBody = {
    tamperproofedValues,
    mintingfee,
    mintingfeeaccount,
  };

  const fetchUrl = `${apiendpoint}/signportal`;
  logger.info(`Calling: ${fetchUrl} - Request ID: ${requestId}`);

  const headers = {
    "Content-Type": "application/json",
    "X-Request-ID": requestId,
  };

  if (current_jwt_token) {
    headers["Authorization"] = `Bearer ${current_jwt_token}`;
  }

  try {
    const result = await fetchWithErrorHandling(fetchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (result.error) {
      logger.error(`SignPortal error - Request ID: ${requestId}`);
      throw new Error(`SignPortal error: ${result.error}: ${result.message}`);
    }

    logger.info(`SignPortal operation successful - Request ID: ${requestId}`);
    return result;
  } catch (error) {
    logger.error(
      `Error during signportal operation: ${error.message} - Request ID: ${requestId}`
    );
    throw error;
  }
}

// The signclient endpoint that the frontend will call
router.post("/signclient", async (req, res) => {
  const requestId = ulid();
  logger.info(`Received signclient request - Request ID: ${requestId}`);

  try {
    // Get data from frontend
    const { tobesignedValues, mintingfee, mintingfeeaccount } = req.body;

    // Basic validation
    if (!tobesignedValues || !mintingfee || !mintingfeeaccount) {
      logger.warn(`Missing required fields - Request ID: ${requestId}`, {
        hasSignedValues: !!tobesignedValues,
        hasMintingFee: !!mintingfee,
        hasMintingFeeAccount: !!mintingfeeaccount,
      });

      return res.status(400).json({
        error: "Missing required fields",
        requestId,
      });
    }

    // Initialize vault and config if not already done
    if (!roditManager.vaultInitialized) {
      logger.info(`Initializing vault - Request ID: ${requestId}`);
      await roditManager.initializeVault();
      await roditManager.initializeRoditConfig("server");
    }

    // Get configuration from state manager
    const config = await stateManager.getConfigOwnRodit();
    if (!config) {
      logger.error(
        `Failed to get RODiT configuration - Request ID: ${requestId}`
      );
      throw new Error("Failed to initialize RODiT configuration");
    }

    const portalPort = 8443;
    if (!stateManager.getJwtToken()) {
      logger.info(`Authenticating with SignPortal - Request ID: ${requestId}`);

       // Make this configurable if needed
      const loginResult = await login_portal(config.own_rodit, portalPort);

      if (!loginResult.jwt_token) {
        logger.error(`Failed to obtain JWT token - Request ID: ${requestId}`);
        throw new Error("Failed to obtain JWT token from SignPortal");
      }

      await stateManager.setJwtToken(loginResult.jwt_token);
      logger.info(
        `Successfully authenticated with SignPortal - Request ID: ${requestId}`
      );
    }

    const tamperproofedValues = {
      openapijson_url: config.own_rodit.metadata.openapijson_url,
      not_after: tobesignedValues.not_after,
      not_before: tobesignedValues.not_before,
      max_requests: tobesignedValues.max_requests,
      maxrq_window: tobesignedValues.maxrq_window,
      webhook_cidr: config.own_rodit.metadata.webhook_cidr,
      allowed_cidr: config.own_rodit.metadata.allowed_cidr,
      allowed_iso3166list: config.own_rodit.metadata.allowed_iso3166list,
      jwt_duration: config.own_rodit.metadata.jwt_duration,
      permissioned_routes: tobesignedValues.permissioned_routes,
      subjectuniqueidentifier_url: config.subjectuniqueidentifier_url,
      serviceprovider_id: config.own_rodit.metadata.serviceprovider_id,
      serviceprovider_signature: tobesignedValues.serviceprovider_signature,
      webhook_url: tobesignedValues.webhookurl,
      userselected_dn: tobesignedValues.userselecteddn,
    };

    // Use the apiendpoint from configuration
    const apiendpoint = config.apiendpoint;

    // Modify these debug lines in the signclient route
    logger.debug(
      `Using tamperproofedValues: ${JSON.stringify({
        serviceprovider_id: tamperproofedValues.serviceprovider_id,
        not_after: tamperproofedValues.not_after,
        not_before: tamperproofedValues.not_before,
      })} - Request ID: ${requestId}`
    );
    logger.debug(`Using mintingfee: ${mintingfee} - Request ID: ${requestId}`);
    logger.debug(
      `Using mintingfeeaccount: ${mintingfeeaccount} - Request ID: ${requestId}`
    );
    // Sign token using SignPortal
    logger.info(`Sending request to SignPortal - Request ID: ${requestId}`);
    const signResult = await signPortalRodit(
      portalPort,
      tamperproofedValues,
      mintingfee,
      mintingfeeaccount
    );

    if (!signResult) {
      throw new Error("Sign operation failed");
    }

    logger.info(
      `Successfully created new RODiT token: ${signResult.token_id} - Request ID: ${requestId}`
    );

    res.status(201).json({
      token_id: signResult.token_id,
      serviceprovider_id: signResult.serviceprovider_id,
      serviceprovider_signature: signResult.serviceprovider_signature,
      fee_signature: signResult.fee_signature,
    });
  } catch (error) {
    logger.error(
      `Error in signclient endpoint - Request ID: ${requestId}: ${error.message}`,
      {
        stack: error.stack,
      }
    );

    res.status(500).json({
      error: "Failed to sign client request",
      details: error.message,
      requestId,
    });
  }
});

module.exports = router;
