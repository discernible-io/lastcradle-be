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
  fetchWithErrorHandling,
} = require("../middleware/initialrodit");

async function signPortalRodit(
  port,
  tamperproofedValues,
  mintingfee,
  mintingfeeaccount
) {
  const requestId = ulid();
  
  // Create context objects for structured logging
  const requestContext = {
    requestId,
    operation: "signPortalRodit",
    serviceProviderId: tamperproofedValues.serviceprovider_id,
    port
  };

  logger.infoWithContext("Sending signportal request", requestContext);

  // Get API endpoint using the stateManager's getPortalUrl method
  const apiendpoint = stateManager.getPortalUrl(
    tamperproofedValues.serviceprovider_id,
    port
  );

  const current_jwt_token = stateManager.getJwtToken();
  const requestBody = {
    tamperproofedValues,
    mintingfee,
    mintingfeeaccount,
  };

  const fetchUrl = `${apiendpoint}/api/portal/signportal`;
  
  const headers = {
    "Content-Type": "application/json",
    "X-Request-ID": requestId,
  };

  if (current_jwt_token) {
    headers["Authorization"] = `Bearer ${current_jwt_token}`;
  }

  // Enhanced logging with structured context
  const apiCallContext = {
    ...requestContext,
    url: fetchUrl,
    headers,
    bodySize: JSON.stringify(requestBody).length,
    hasToken: !!current_jwt_token
  };
  
  logger.infoWithContext("Preparing SignPortal API call", apiCallContext);
  
  // Separate sensitive data into debug level logs
  logger.debugWithContext("Request body details", {
    ...requestContext,
    body: requestBody
  });

  try {
    const result = await fetchWithErrorHandling(fetchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    logger.infoWithContext("Raw response received from SignPortal", {
      ...requestContext,
      responseReceived: true
    });

    if (result.error) {
      const errorContext = {
        ...requestContext,
        errorCode: result.error,
        errorMessage: result.message
      };
      
      logger.errorWithContext("SignPortal error response", errorContext);
      throw new Error(`SignPortal error: ${result.error}: ${result.message}`);
    }

    logger.infoWithContext("SignPortal operation successful", {
      ...requestContext,
      tokenId: result.token_id
    });
    
    return result;
  } catch (error) {
    logger.errorWithContext("Error during signportal operation", 
      {
        ...requestContext,
        errorMessage: error.message
      },
      error // Pass the error object directly for stack trace
    );
    throw error;
  }
}

// The signclient endpoint that the frontend will call
router.post("/signclient", async (req, res) => {
  const requestId = ulid();
  
  // Create base context object for consistent logging
  const baseContext = {
    requestId,
    endpoint: "/signclient",
    method: req.method,
    ip: req.ip,
    userAgent: req.get("User-Agent")
  };
  
  logger.infoWithContext("Received signclient request", baseContext);

  try {
    // Get data from frontend
    const { tobesignedValues, mintingfee, mintingfeeaccount } = req.body;

    // Enhanced context with request validation
    const validationContext = {
      ...baseContext,
      hasSignedValues: !!tobesignedValues,
      hasMintingFee: !!mintingfee,
      hasMintingFeeAccount: !!mintingfeeaccount
    };

    // Basic validation
    if (!tobesignedValues || !mintingfee || !mintingfeeaccount) {
      logger.warnWithContext("Missing required fields in signclient request", validationContext);

      return res.status(400).json({
        error: "Missing required fields",
        requestId,
      });
    }

    // Initialize vault and config if not already done
    if (!roditManager.vaultInitialized) {
      logger.infoWithContext("Initializing vault for signclient", baseContext);
      await roditManager.initializeVault();
      await roditManager.initializeRoditConfig("server");
    }

    // Get configuration from state manager
    const config = await stateManager.getConfigOwnRodit();
    if (!config) {
      logger.errorWithContext("Failed to get RODiT configuration", baseContext);
      throw new Error("Failed to initialize RODiT configuration");
    }

    const portalPort = 8443;
    
    // JWT Token management
    const jwtContext = {
      ...baseContext,
      portalPort,
      hasExistingToken: !!stateManager.getJwtToken()
    };
    
    if (!stateManager.getJwtToken()) {
      logger.infoWithContext("Authenticating with SignPortal", jwtContext);

      // Make this configurable if needed
      const loginResult = await login_portal(config.own_rodit, portalPort);

      if (!loginResult.jwt_token) {
        logger.errorWithContext("Failed to obtain JWT token", jwtContext);
        throw new Error("Failed to obtain JWT token from SignPortal");
      }

      await stateManager.setJwtToken(loginResult.jwt_token);
      logger.infoWithContext("Successfully authenticated with SignPortal", jwtContext);
    }

    const tamperproofedValues = {
      openapijson_url: config.own_rodit.metadata.openapijson_url,
      not_after: tobesignedValues.not_after,
      not_before: config.own_rodit.metadata.not_before,
      max_requests: String(tobesignedValues.max_requests),    // Explicit conversion to string
      maxrq_window: String(tobesignedValues.maxrq_window),
      webhook_cidr: config.own_rodit.metadata.webhook_cidr,
      allowed_cidr: config.own_rodit.metadata.allowed_cidr,
      allowed_iso3166list: config.own_rodit.metadata.allowed_iso3166list,
      jwt_duration: config.own_rodit.metadata.jwt_duration,
      permissioned_routes: tobesignedValues.permissioned_routes,
      subjectuniqueidentifier_url: config.own_rodit.metadata.subjectuniqueidentifier_url,
      serviceprovider_id: config.own_rodit.metadata.serviceprovider_id,
      serviceprovider_signature: tobesignedValues.serviceprovider_signature,
    };

    // Log critical information at debug level with proper context
    const tokenContext = {
      ...baseContext,
      serviceprovider_id: tamperproofedValues.serviceprovider_id,
      not_after: tamperproofedValues.not_after,
      not_before: tamperproofedValues.not_before,
      mintingfee,
      mintingfeeaccount
    };
    
    logger.debugWithContext("Prepared tamperproofed values for signing", tokenContext);
    
    // Sign token using SignPortal
    logger.infoWithContext("Sending request to SignPortal", {
      ...baseContext,
      operation: "signPortalRodit"
    });
    
    const signResult = await signPortalRodit(
      portalPort,
      tamperproofedValues,
      mintingfee,
      mintingfeeaccount
    );

    if (!signResult) {
      logger.errorWithContext("Sign operation failed with null result", baseContext);
      throw new Error("Sign operation failed");
    }

    // Success response
    const successContext = {
      ...baseContext,
      token_id: signResult.token_id,
      status: "success"
    };
    
    logger.infoWithContext("Successfully created new RODiT token", successContext);

    res.status(201).json(signResult);
  } catch (error) {
    const errorContext = {
      ...baseContext,
      errorMessage: error.message,
      errorName: error.name
    };
    
    logger.errorWithContext("Error in signclient endpoint", errorContext, error);

    res.status(500).json({
      error: "Failed to sign client request",
      details: error.message,
      requestId,
    });
  }
});

module.exports = router;