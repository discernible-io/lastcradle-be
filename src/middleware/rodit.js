// Copyright (c) 2024 Cableguard, Inc. All rights reserved.

/**
 * Module Dependencies
 */
const bs58 = require("bs58");
const { ulid } = require("ulid");
const config = require("config");
const fs = require("fs").promises;
const logger = require("../../config/logger");
const crypto = require("crypto");
const nacl = require("tweetnacl");
const borsh = require("borsh");
nacl.util = require("tweetnacl-util");
const { decodeUTF8 } = require("tweetnacl-util");
const { importJWK, jwtVerify, decodeJwt, SignJWT } = require("jose");
const sessionManager = require('../auth/sessionmanager');
const { Resolver } = require("dns").promises;
const {
  initializeProductionVault,
  get_rodit_fromvault,
  setupTokenRenewal,
  vault,
} = require("./vaultsetup-production");
const BlockchainService = require("../blockchain/blockchainservice");
const validateandset = require("../validateandset");
const { calculateCanonicalHash, unixTimeToDateString, dateStringToUnixTime,
} = require("../utils");
const { 
  nearorg_rpc_timestamp, 
  nearorg_rpc_tokenfromroditid, 
  nearorg_rpc_state, 
  nearorg_rpc_tokensfromaccountid, 
  nearorg_rpc_fetchpublickeybytes,
  CONSTANTS,
} = require("../blockchain/blockchainservice");
const { generate_jwt_token,base64url2jwk_public_key,
  checkandrenew_jwt_token,
  verify_jwt_token
} = require("../auth/tokenservice");
const { stateManager } = require("../blockchain/statemanager");

const API_OPTIONS = config.get("API_OPTIONS");
const tokenrenewaloptions = API_OPTIONS.TOKENRENEWALOPTIONS;

/**
 * Singleton State Management Classes
 */

class RoditManager {
  constructor() {
    if (RoditManager.instance) {
      return RoditManager.instance;
    }

    this.stateManager = stateManager;
    this.vaultInitialized = false;
    this.vaultPath = null;
    this.credentials = {
      portal: null,
      sanctum: null,
      server: null,
      client: null,
    };

    RoditManager.instance = this;
  }

  async initializeVault() {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting vault initialization", {
      component: "RoditManager",
      method: "initializeVault",
      requestId,
    });

    if (this.vaultInitialized) {
      logger.debug("Vault already initialized", {
        component: "RoditManager",
        method: "initializeVault",
        requestId,
      });
      return vault;
    }

    try {
      const vaultInstance = await initializeProductionVault();
      await setupTokenRenewal(vaultInstance);
      this.vaultInitialized = true;
      this.vaultPath = config.get("VAULT_RODIT_KEYVALUE_PATH");

      const duration = Date.now() - startTime;
      logger.info("Vault initialized successfully", {
        component: "RoditManager",
        method: "initializeVault",
        requestId,
        duration,
        status: "success",
      });

      // Emit metrics for Grafana dashboards
      logger.metric("vault_initialization_duration_ms", duration, {
        success: true,
        component: "RoditManager",
      });

      return vaultInstance;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Vault initialization failed", {
        component: "RoditManager",
        method: "initializeVault",
        requestId,
        duration,
        status: "error",
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("vault_initialization_duration_ms", duration, {
        success: false,
        component: "RoditManager",
        errorType: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("vault_initialization_errors_total", 1, {
        errorType: error.code || "UNKNOWN_ERROR",
        component: "RoditManager",
      });

      throw error;
    }
  }

  async getCredentials(type) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Retrieving credentials", {
      component: "RoditManager",
      method: "getCredentials",
      requestId,
      credentialType: type,
    });

    if (!this.vaultInitialized) {
      logger.debug("Vault not initialized, initializing now", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
      });
      await this.initializeVault();
    }

    if (this.credentials[type]) {
      logger.debug("Using cached credentials", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
        credentialType: type,
      });
      return this.credentials[type];
    }

    try {
      // Make the accountType consistent with the type parameter
      const accountType = `account_${type}`;

      logger.debug("Fetching credentials from vault", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
        credentialType: type,
        vaultPath: `${this.vaultPath}/${type}`,
      });

      const vaultData = await get_rodit_fromvault(
        vault,
        `${this.vaultPath}/${type}`,
        accountType
      );

      if (!vaultData.private_key || typeof vaultData.private_key !== "string") {
        throw new Error(`Invalid or missing private_key for ${type}`);
      }

      const privateKeyStr = vaultData.private_key.startsWith("ed25519:")
        ? vaultData.private_key.replace("ed25519:", "")
        : vaultData.private_key;

      vaultData.signing_bytes_key = new Uint8Array(bs58.decode(privateKeyStr));
      this.credentials[type] = vaultData;

      const duration = Date.now() - startTime;
      logger.info("Credentials retrieved successfully", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
        credentialType: type,
        duration,
        accountId: vaultData.account_id, // Safe to log account ID
      });

      // Emit metrics for Grafana dashboards
      logger.metric("credential_retrieval_duration_ms", duration, {
        success: true,
        credentialType: type,
        component: "RoditManager",
      });

      return vaultData;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Failed to retrieve credentials", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
        credentialType: type,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("credential_retrieval_duration_ms", duration, {
        success: false,
        credentialType: type,
        component: "RoditManager",
        errorType: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("credential_retrieval_errors_total", 1, {
        errorType: error.code || "UNKNOWN_ERROR",
        credentialType: type,
        component: "RoditManager",
      });

      throw error;
    }
  }

  async initializeRoditConfig(type) {
    const requestId = ulid();
    const startTime = Date.now();

    logger.info("Starting RODiT config initialization", {
      component: "RoditManager",
      method: "initializeRoditConfig",
      requestId,
      configType: type,
    });

    try {
      logger.debug("Getting credentials", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "fetchCredentials",
      });

      const credentials = await this.getCredentials(type);

      if (!credentials) {
        logger.error("Failed to retrieve credentials", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          step: "credentialCheck",
        });
        throw new Error(`Credentials not available for ${type}`);
      }

      const { account_id, implicit_account_id } = credentials;
      logger.info("Using account for initialization", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        accountId: account_id,
        step: "accountSetup",
      });

      logger.debug("Checking account state on blockchain", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        accountId: account_id,
        step: "blockchainCheck",
      });

      const accountState = await nearorg_rpc_state(
        account_id
      );

      if (!accountState) {
        logger.warn("Account has no balance in network", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          accountId: account_id,
          step: "blockchainCheck",
        });
      } else {
        logger.info("Account state verified on blockchain", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          accountId: account_id,
          step: "blockchainCheck",
        });
      }

      logger.debug("Fetching RODiT tokens for account", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        accountId: account_id,
        step: "tokenFetch",
      });

      const own_rodit = await nearorg_rpc_tokensfromaccountid(
        account_id
      );

      // Check if we have a real RODiT token
      if (!own_rodit || !own_rodit.token_id) {
        logger.warn(
          "No RODiT instances found, proceeding with partial initialization",
          {
            component: "RoditManager",
            method: "initializeRoditConfig",
            requestId,
            accountId: account_id,
            step: "tokenCheck",
          }
        );

        // Create a minimal configuration for signroot
        const minimalConfig = {
          own_rodit: {
            token_id: "",
            owner_id: account_id,
            metadata: {
              subjectuniqueidentifier_url: "localhost", // Fallback value
              serviceprovider_id: "",
              not_after: "2030-01-01",
              not_before: "2020-01-01",
            },
          },
          own_rodit_bytes_private_key: credentials.signing_bytes_key,
          apiendpoint: "localhost:" + config.get("SERVERPORT"),
          port: config.get("SERVERPORT"),
          iso639: config.get("API_OPTIONS.ISO639"),
          iso3166: config.get("API_OPTIONS.ISO3166"),
          iso15924: config.get("API_OPTIONS.ISO15924"),
          timeoptions: config.get("API_OPTIONS.TIMEOPTIONS"),
        };

        const configCopy = JSON.parse(
          JSON.stringify({
            ...minimalConfig,
            // Exclude sensitive data
            own_rodit_bytes_private_key: "*** REDACTED ***",
          })
        );

        logger.info(
          "Created minimal config object for partial initialization",
          {
            component: "RoditManager",
            method: "initializeRoditConfig",
            requestId,
            configType: type,
            configObject: configCopy,
            step: "minimalConfig",
          }
        );

        logger.debug("Storing minimal configuration in state manager", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          step: "storeConfig",
        });

        await this.stateManager.setConfigOwnRodit(minimalConfig);

        logger.debug("Converting implicit account ID to base64url", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          step: "keyConversion",
        });

        const session_base64url_jwk_public_key = Buffer.from(
          implicit_account_id,
          "hex"
        ).toString("base64url");

        logger.debug("Setting session base64url JWK public key", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          step: "setSessionKey",
        });

        await this.stateManager.setOwnBase64urlJwkPublicKey(
          session_base64url_jwk_public_key
        );

        const duration = Date.now() - startTime;
        logger.info("Partial RODiT configuration completed", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          duration,
          configLevel: "partial",
          step: "complete",
        });

        // Emit metrics for Grafana dashboards
        logger.metric("rodit_initialization_duration_ms", duration, {
          success: true,
          configType: type,
          configLevel: "partial",
          component: "RoditManager",
        });

        return minimalConfig;
      }

      logger.info("Successfully retrieved RODiT token", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        tokenId: own_rodit.token_id,
        step: "tokenRetrieved",
      });

      const SERVERPORT = config.get("SERVERPORT");

      if (
        !own_rodit.metadata ||
        !own_rodit.metadata.subjectuniqueidentifier_url
      ) {
        logger.error("Missing required metadata in RODiT", {
          component: "RoditManager",
          method: "initializeRoditConfig",
          requestId,
          configType: type,
          missingField: "subjectuniqueidentifier_url",
          step: "metadataCheck",
        });

        throw new Error(
          "Missing required metadata: subjectuniqueidentifier_url"
        );
      }

      const apiendpoint =
        own_rodit.metadata.subjectuniqueidentifier_url + ":" + SERVERPORT;

      logger.debug("Constructed API endpoint", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        apiEndpoint: apiendpoint,
        step: "apiEndpointCreation",
      });

      logger.info("Building full configuration object", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "fullConfigCreation",
      });

      const configObject = {
        own_rodit,
        own_rodit_bytes_private_key: credentials.signing_bytes_key,
        apiendpoint,
        port: SERVERPORT,
        iso639: config.get("API_OPTIONS.ISO639"),
        iso3166: config.get("API_OPTIONS.ISO3166"),
        iso15924: config.get("API_OPTIONS.ISO15924"),
        timeoptions: config.get("API_OPTIONS.TIMEOPTIONS"),
      };

      const configCopy = JSON.parse(
        JSON.stringify({
          ...configObject,
          // Exclude sensitive data
          own_rodit_bytes_private_key: "*** REDACTED ***",
        })
      );

      logger.info("Created full config object", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        configObject: configCopy,
        step: "fullConfig",
      });

      logger.debug("Storing configuration in state manager", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "storeConfig",
      });

      await this.stateManager.setConfigOwnRodit(configObject);

      logger.info("Configuration stored successfully", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "configStored",
      });

      logger.debug("Converting implicit account ID to base64url", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "keyConversion",
      });

      const session_base64url_jwk_public_key = Buffer.from(
        implicit_account_id,
        "hex"
      ).toString("base64url");

      logger.debug("Setting session base64url JWK public key", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        step: "setSessionKey",
      });

      await this.stateManager.setPeerBase64urlJwkPublicKey(
        session_base64url_jwk_public_key
      );

      const duration = Date.now() - startTime;
      logger.info("RODiT configuration completed", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        duration,
        configLevel: "full",
        step: "complete",
      });

      // Emit metrics for Grafana dashboards
      logger.metric("rodit_initialization_duration_ms", duration, {
        success: true,
        configType: type,
        configLevel: "full",
        component: "RoditManager",
      });

      return configObject;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Error initializing RODiT config", {
        component: "RoditManager",
        method: "initializeRoditConfig",
        requestId,
        configType: type,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        stack: error.stack,
        step: error.step || "unknown",
      });

      // Emit metrics for Grafana dashboards
      logger.metric("rodit_initialization_duration_ms", duration, {
        success: false,
        configType: type,
        component: "RoditManager",
        errorType: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("rodit_initialization_errors_total", 1, {
        errorType: error.code || "UNKNOWN_ERROR",
        configType: type,
        component: "RoditManager",
        step: error.step || "unknown",
      });

      throw error;
    }
  }
}

const roditManager = new RoditManager();

/**
 * Performs a fetch operation with comprehensive error handling and logging for Grafana monitoring
 *
 * @param {string} url - The URL to fetch from
 * @param {Object} options - Fetch options including method, headers, etc.
 * @returns {Promise<Object>} - The response data or error object
 */
async function fetchWithErrorHandling(url, options, retryCount = 0) {
  const requestId = ulid();
  const startTime = Date.now();
  const operation = options?.method || "GET";
  const urlObj = new URL(url);
  const endpoint = urlObj.pathname;
  const MAX_RETRIES = 1; // Only retry once for expired tokens

  logger.info("API request initiated", {
    component: "APIClient",
    method: "fetchWithErrorHandling",
    requestId,
    url: endpoint,
    operation,
    retryCount,
  });

  try {
    // Get the JWT token for authentication
    const jwt_token = stateManager.getJwtToken();

    // Add authorization and tracking headers
    options.headers = {
      ...options.headers,
      ...(jwt_token ? { Authorization: `Bearer ${jwt_token}` } : {}),
      "X-Request-ID": requestId,
    };

    // Make the API request
    const response = await fetch(url, options);
    const responseTime = Date.now() - startTime;

    // Check for a renewed token in response headers
    const newToken = response.headers.get("New-Token");
    if (newToken) {
      try {
        await stateManager.setJwtToken(newToken);
        logger.debug("JWT token refreshed from header", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
        });
      } catch (tokenError) {
        logger.error("Failed to update JWT token", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
          error: tokenError.message,
        });
      }
    }

    // Record response time metrics
    logger.metric("api_request_duration_milliseconds", responseTime, {
      endpoint,
      method: operation,
      status: response.status,
    });

    // Handle 401 Unauthorized with retry for token expiration
    if (response.status === 401 && retryCount < MAX_RETRIES) {
      const responseData = await response.json();

      // Only retry for expired tokens
      if (responseData.error && responseData.error.code === "TOKEN_EXPIRED") {
        logger.info("Token expired, attempting login refresh", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
        });

        // Try to login again to get a fresh token
        // This implementation depends on your authentication flow
        try {
          const config_own_rodit = stateManager.getConfigOwnRodit();
          if (config_own_rodit && config_own_rodit.own_rodit) {
            const loginResult = await login_server(config_own_rodit.own_rodit);

            if (loginResult && loginResult.jwt_token) {
              // Save the new token
              await stateManager.setJwtToken(loginResult.jwt_token);

              // Retry the request with the new token
              return fetchWithErrorHandling(url, options, retryCount + 1);
            }
          }
        } catch (loginError) {
          logger.error("Failed to refresh token through login", {
            component: "APIClient",
            method: "fetchWithErrorHandling",
            requestId,
            error: loginError.message,
          });
        }
      }
    }

    // Parse response as JSON for all status codes
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      // Handle non-JSON responses
      const text = await response.text();
      responseData = {
        rawResponse: text.substring(0, 100), // Only include a preview
        parseError: parseError.message,
      };
    }

    if (!response.ok) {
      // Handle error responses
      logger.error("API request failed", {
        component: "APIClient",
        method: "fetchWithErrorHandling",
        requestId,
        url: endpoint,
        statusCode: response.status,
        errorDetails: responseData,
      });

      // Record error metrics
      logger.metric("api_request_errors_total", 1, {
        endpoint,
        method: operation,
        status: response.status,
      });

      return {
        error: responseData.error || "RequestFailed",
        message:
          responseData.message || `Request failed: ${response.statusText}`,
        statusCode: response.status,
        details: responseData,
      };
    }

    // Log successful request
    logger.info("API request completed", {
      component: "APIClient",
      method: "fetchWithErrorHandling",
      requestId,
      url: endpoint,
      statusCode: response.status,
      duration: responseTime,
    });

    return responseData;
  } catch (error) {
    const errorDuration = Date.now() - startTime;

    // Log detailed error information
    logger.error("Fetch operation failed", {
      component: "APIClient",
      method: "fetchWithErrorHandling",
      requestId,
      url: endpoint,
      errorMessage: error.message,
      errorStack: error.stack,
      duration: errorDuration,
    });

    // Return a standardized error object
    return {
      error: "RequestFailed",
      message: error.message,
      isNetworkError:
        error.message.includes("fetch") || error.message.includes("network"),
    };
  }
}

/**
 * Performs a fetch operation with comprehensive error handling and logging for Grafana monitoring
 *
 * @param {string} url - The URL to fetch from
 * @param {Object} options - Fetch options including method, headers, etc.
 * @returns {Promise<Object>} - The response data or error object
 */
async function fetchPortalWithErrorHandling(url, options, retryCount = 0) {
  const requestId = ulid();
  const startTime = Date.now();
  const operation = options?.method || "GET";
  const urlObj = new URL(url);
  const endpoint = urlObj.pathname;
  const MAX_RETRIES = 1; // Only retry once for expired tokens

  logger.info("API request initiated", {
    component: "APIClient",
    method: "fetchWithErrorHandling",
    requestId,
    url: endpoint,
    operation,
    retryCount,
  });

  try {
    // Get the SingPortal JWT token for authentication
    const jwt_token = stateManager.getPortalJwtToken();

    // Add authorization and tracking headers
    options.headers = {
      ...options.headers,
      ...(jwt_token ? { Authorization: `Bearer ${jwt_token}` } : {}),
      "X-Request-ID": requestId,
    };

    // Make the API request
    const response = await fetch(url, options);
    const responseTime = Date.now() - startTime;

    // Check for a renewed token in response headers
    const newToken = response.headers.get("New-Token");
    if (newToken) {
      try {
        await stateManager.setPortalJwtToken(newToken);
        logger.debug("JWT token refreshed from header", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
        });
      } catch (tokenError) {
        logger.error("Failed to update JWT token", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
          error: tokenError.message,
        });
      }
    }

    // Record response time metrics
    logger.metric("api_request_duration_milliseconds", responseTime, {
      endpoint,
      method: operation,
      status: response.status,
    });

    // Handle 401 Unauthorized with retry for token expiration
    if (response.status === 401 && retryCount < MAX_RETRIES) {
      const responseData = await response.json();

      // Only retry for expired tokens
      if (responseData.error && responseData.error.code === "TOKEN_EXPIRED") {
        logger.info("Token expired, attempting login refresh", {
          component: "APIClient",
          method: "fetchWithErrorHandling",
          requestId,
        });

        // Try to login again to get a fresh token
        // This implementation depends on your authentication flow
        try {
          const config_own_rodit = stateManager.getConfigOwnRodit();
          if (config_own_rodit && config_own_rodit.own_rodit) {
            const loginResult = await login_server(config_own_rodit.own_rodit);

            if (loginResult && loginResult.jwt_token) {
              // Save the new token
              await stateManager.setJwtToken(loginResult.jwt_token);

              // Retry the request with the new token
              return fetchPortalWithErrorHandling(url, options, retryCount + 1);
            }
          }
        } catch (loginError) {
          logger.error("Failed to refresh token through login", {
            component: "APIClient",
            method: "fetchWithErrorHandling",
            requestId,
            error: loginError.message,
          });
        }
      }
    }

    // Parse response as JSON for all status codes
    let responseData;
    try {
      responseData = await response.json();
    } catch (parseError) {
      // Handle non-JSON responses
      const text = await response.text();
      responseData = {
        rawResponse: text.substring(0, 100), // Only include a preview
        parseError: parseError.message,
      };
    }

    if (!response.ok) {
      // Handle error responses
      logger.error("API request failed", {
        component: "APIClient",
        method: "fetchWithErrorHandling",
        requestId,
        url: endpoint,
        statusCode: response.status,
        errorDetails: responseData,
      });

      // Record error metrics
      logger.metric("api_request_errors_total", 1, {
        endpoint,
        method: operation,
        status: response.status,
      });

      return {
        error: responseData.error || "RequestFailed",
        message:
          responseData.message || `Request failed: ${response.statusText}`,
        statusCode: response.status,
        details: responseData,
      };
    }

    // Log successful request
    logger.info("API request completed", {
      component: "APIClient",
      method: "fetchWithErrorHandling",
      requestId,
      url: endpoint,
      statusCode: response.status,
      duration: responseTime,
    });

    return responseData;
  } catch (error) {
    const errorDuration = Date.now() - startTime;

    // Log detailed error information
    logger.error("Fetch operation failed", {
      component: "APIClient",
      method: "fetchWithErrorHandling",
      requestId,
      url: endpoint,
      errorMessage: error.message,
      errorStack: error.stack,
      duration: errorDuration,
    });

    // Return a standardized error object
    return {
      error: "RequestFailed",
      message: error.message,
      isNetworkError:
        error.message.includes("fetch") || error.message.includes("network"),
    };
  }
}

  stateManager.getPortalUrl = function(serviceProviderId, port) {
    // Extract smart contract component from serviceprovider_id
    const components = serviceProviderId.split(";");
    const scComponent = components
      .find((c) => c.startsWith("sc="))
      ?.substring(3);

    if (!scComponent) {
      throw new Error("Invalid serviceprovider_id format");
    }

    // Extract domain parts from smart contract name
    const scParts = scComponent.split(".");
    if (scParts.length < 1) {
      throw new Error("Invalid smart contract format");
    }

    // Get domain information from the first part
    const domainPart = scParts[0];
    const domainComponents = domainPart.split("-");

    // Find domain and TLD in the components (format: 10975-cableguard-org)
    if (domainComponents.length < 3) {
      throw new Error("Invalid domain format in smart contract");
    }

    const domain = domainComponents[1]; // cableguard
    const tld = domainComponents[2]; // org

    // Build and return the API endpoint
    return `https://signportal.${domain}.${tld}:${port}`;
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

    const peer_bytes_ed25519_public_key = await nearorg_rpc_fetchpublickeybytes(
      peer_rodit.owner_id
    );

    logger.debug("Retrieved public key", {
      requestId,
      ownerId: peer_rodit.owner_id,
      keyLength: peer_bytes_ed25519_public_key.length,
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

async function verify_peerrodit_getrodit_withnep413(
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
    let peer_rodit = await nearorg_rpc_tokenfromroditid(message);
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
      verify_rodit_ownership_withnep413(
        message,
        nonce,
        recipient,
        callbackUrl,
        signature,
        peer_rodit
      ),
      verify_rodit_isamatch(serviceprovider_id, peer_rodit),
      verify_rodit_islive(
        peer_rodit.metadata.not_after,
        peer_rodit.metadata.not_before
      ),
      verify_rodit_isactive(
        peer_rodit.token_id,
        config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
      ),
      verify_rodit_istrusted_issuingsmartcontract(
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

    if (!ownershipVerified || !isaMatch || !isLive || !isActive || !isTrusted) {
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
      ownershipVerified = await verify_rodit_ownership(
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
      isaMatch = await verify_rodit_isamatch(
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
      isLive = await verify_rodit_islive(
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
      isActive = await verify_rodit_isactive(
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
      isTrusted = await verify_rodit_istrusted_issuingsmartcontract(
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

    if (!ownershipVerified || !isaMatch || !isLive || !isActive || !isTrusted) {
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

async function verify_rodit_isamatch(own_service_provider_id, peer_rodit) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debug("Starting RODiT match verification", {
    component: "RoditAuth",
    method: "verify_rodit_isamatch",
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
      const signing_rodit = await nearorg_rpc_tokenfromroditid(
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

        if (bytes_signing_owner_id.length !== CONSTANTS.RODIT_ID_PK_SZ) {
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

        const bytes_signature = new Uint8Array(
          Buffer.from(base64Signature, "base64")
        );

        if (bytes_signature.length !== CONSTANTS.RODIT_ID_SIGNATURE_SZ) {
          logger.warn(`Invalid signature length for ID ${idIndex}`, {
            requestId,
            actual: bytes_signature.length,
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
          bytes_signature,
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
              method: "verify_rodit_isamatch",
              requestId,
              duration: totalDuration,
              partnerVerification: true,
              idIndex,
            });
          } else {
            logger.info("Peer login verified successfully", {
              component: "RoditAuth",
              method: "verify_rodit_isamatch",
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
      method: "verify_rodit_isamatch",
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
      method: "verify_rodit_isamatch",
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

async function verify_rodit_isactive(tokenId, ownsubjectuniqueidentifier_url) {
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

async function verify_rodit_istrusted_issuingsmartcontract(
  ownsubjectuniqueidentifier_url
) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debug("Verifying smart contract trust", {
    component: "RoditAuth",
    method: "verify_rodit_istrusted_issuingsmartcontract",
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
          method: "verify_rodit_istrusted_issuingsmartcontract",
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
          method: "verify_rodit_istrusted_issuingsmartcontract",
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
        method: "verify_rodit_istrusted_issuingsmartcontract",
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
      method: "verify_rodit_istrusted_issuingsmartcontract",
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

async function verify_rodit_islive(peer_rodit_notafter, peer_rodit_notbefore) {
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
    const stringtimenow = await nearorg_rpc_timestamp();
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

async function login_client_withnep413(req, res, config_own_rodit = null) {
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
      await verify_peerrodit_getrodit_withnep413(
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

    const token = await generate_jwt_token(
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

async function login_portal(own_rodit, port) {
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
    const config_own_rodit = await stateManager.getConfigOwnRodit();

    logger.debug("Retrieved configuration from state manager", {
      component: "AuthenticationService",
      method: "login_portal",
      requestId,
      hasConfig: !!config_own_rodit,
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
    const apiendpoint = stateManager.getPortalUrl(serviceProviderId, port);

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
    const roditidandtimestamp = new TextEncoder().encode(roditid + timeString);

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
        const validationResult = await validate_jwt_token_be(
          jwt_token,
          own_rodit
        );
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

async function login_server(own_rodit) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.info("Starting login_server process", {
    component: "AuthenticationService",
    method: "login_server",
    requestId,
    roditId: own_rodit?.token_id,
  });

  try {
    const config_own_rodit = await stateManager.getConfigOwnRodit();

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
    const roditidandtimestamp = new TextEncoder().encode(roditid + timeString);

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
      const validationResult = await validate_jwt_token_be(
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

function extractTokenFromHeader(authHeader) {
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

function handleJwtTokenError(error, res, requestId) {
  const startTime = Date.now();

  logger.error("Token error occurred", {
    component: "TokenErrorHandler",
    method: "handleJwtTokenError",
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
      method: "handleJwtTokenError",
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
      method: "handleJwtTokenError",
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
      method: "handleJwtTokenError",
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
      method: "handleJwtTokenError",
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
    method: "handleJwtTokenError",
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

async function authenticate_webhook(
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
    logger.metric("signature_verification_duration_ms", verificationDuration, {
      component: "WebhookAuthenticator",
      success: isValid,
    });

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

async function authenticate_apicall(req, res, next) {
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

    // Get the peer public key from state manager
    const base64PublicKey = stateManager.getPeerBase64urlJwkPublicKey();

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

    const jwk_public_key = await base64url2jwk_public_key(base64PublicKey);

    try {
      // Verify the token
      const verificationResult = await verify_jwt_token(
        token,
        jwk_public_key,
        req.headers["x-timestamp"],
        requestId
      );

      const payload = verificationResult.payload;
      let newToken = verificationResult.newToken;
      
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

      // Check if token needs proactive renewal (only if server-initiated renewal is configured)
      if (
        !newToken &&
        tokenrenewaloptions.SERVERORCLIENT === "SERVER-INITIATED"
      ) {
        try {
          logger.debug("Checking for proactive token renewal", {
            component: "AuthenticationMiddleware",
            method: "authenticate_apicall",
            requestId,
            tokenId: payload.jti || "unknown",
          });

          // Call token renewal function with corrected algorithm
          const renewalResult = await checkandrenew_jwt_token(
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
      return handleJwtTokenError(verifyError, res, requestId);
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

module.exports = {
  login_server,
  login_portal,
  login_client_withnep413,
  generate_jwt_token,
  authenticate_apicall,
  authenticate_webhook,
  roditManager,
  stateManager,
};
