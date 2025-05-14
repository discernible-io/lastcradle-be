/**
 * Integration layer for backward compatibility with existing code
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const bs58 = require("bs58");
const logger = require("../../config/logger");
const BlockchainService = require("../blockchain/blockchainservice");
const session = require("../auth/sessionmanager");
const validators = require("../validators");
const utils = require("../utils");
const { initializeProductionVault } = require("./vaultsetup-production");
const config = require("config");

/**
 * Constants and Configuration
 */
const CONSTANTS = {
  SMART_CONTRACT: config.get("APISERVICEOPTIONS.scaccountid"),
  SMART_CONTRACT_REVOKED: "10975-revoked-cableguard-org.testnet",
  BLOCKCHAIN_NETWORK: config.get("NEAR_NETWORK_ID"),
  RODIT_ID_SZ: 128,
  RODIT_ID_PK_SZ: 32,
  RODIT_ID_SIGNATURE_SZ: 64,
  ED25519_KEY_SZ: 64,
};

// Safely get configuration values with fallbacks
const getConfig = (path, defaultValue) => {
  try {
    return config.get(path);
  } catch (error) {
    logger.warn(`Failed to get config value for ${path}, using default`, {
      component: "ConfigLoader",
      error: error.message,
      defaultValue
    });
    return defaultValue;
  }
};

const API_OPTIONS = getConfig("API_OPTIONS", {});
const SERVERPORT = getConfig("SERVERPORT", 8080);
const NEAR_RPC_URL = getConfig("NEAR_RPC_URL", "");
const API_URL = getConfig("API_URL", "");
const SERVER_FRONTEND_URL = getConfig("SERVER_FRONTEND_URL", "");
const CLIENT_FRONTEND_URL = getConfig("CLIENT_FRONTEND_URL", "");

/**
 * Singleton State Management Classes
 */
class AuthStateManager {
  // Private static instance - the only instance that will exist
  static #instance = null;
  
  // Public static method to get the instance
  static getInstance() {
    if (!AuthStateManager.#instance) {
      AuthStateManager.#instance = new AuthStateManager();
    }
    return AuthStateManager.#instance;
  }

  // Private constructor to prevent external instantiation
  constructor() {
    // Only allow instantiation if no instance exists
    if (AuthStateManager.#instance) {
      return AuthStateManager.#instance;
    }
    
    // Initialize properties
    this.ownBase64urlJwkPublicKey = null;
    this.peerBase64urlJwkPublicKey = null;
    this.configOwnRodit = null;
    this.jwtToken = null;
    
    // Store this instance
    AuthStateManager.#instance = this;
  }

  // Methods for own public key
  async setOwnBase64urlJwkPublicKey(key) {
    this.ownBase64urlJwkPublicKey = key;
    return key;
  }

  getOwnBase64urlJwkPublicKey() {
    return this.ownBase64urlJwkPublicKey;
  }

  // Methods for peer public key
  async setPeerBase64urlJwkPublicKey(key) {
    this.peerBase64urlJwkPublicKey = key;
    return key;
  }

  getPeerBase64urlJwkPublicKey() {
    return this.peerBase64urlJwkPublicKey;
  }

  // Methods for RODiT configuration
  async setConfigOwnRodit(config) {
    this.configOwnRodit = config;
    return config;
  }

  getConfigOwnRodit() {
    return this.configOwnRodit;
  }

  // Methods for JWT token
  async setJwtToken(token) {
    this.jwtToken = token;
    return token;
  }

  getJwtToken() {
    return this.jwtToken;
  }

  // Generate portal URL from service provider ID
  getPortalUrl(serviceProviderId, port) {
    if (!serviceProviderId) {
      logger.error("Invalid serviceProviderId: undefined", {
        component: "AuthStateManager",
        method: "getPortalUrl"
      });
      return null;
    }

    try {
      // Extract smart contract component from serviceprovider_id
      const components = serviceProviderId.split(";");
      const scComponent = components
        .find((c) => c.startsWith("sc="))
        ?.substring(3);

      if (!scComponent) {
        logger.error("Invalid serviceprovider_id format, missing sc= component", {
          component: "AuthStateManager",
          method: "getPortalUrl",
          serviceProviderId
        });
        return null;
      }

      // Extract domain parts from smart contract name
      const scParts = scComponent.split(".");
      if (scParts.length < 1) {
        logger.error("Invalid smart contract format", {
          component: "AuthStateManager",
          method: "getPortalUrl",
          scComponent
        });
        return null;
      }

      // Get domain information from the first part
      const domainPart = scParts[0];
      const domainComponents = domainPart.split("-");

      // Find domain and TLD in the components (format: 10975-cableguard-org)
      if (domainComponents.length < 3) {
        logger.error("Invalid domain format in smart contract", {
          component: "AuthStateManager",
          method: "getPortalUrl",
          domainPart
        });
        return null;
      }

      const domain = domainComponents[1]; // cableguard
      const tld = domainComponents[2]; // org

      // Build and return the API endpoint
      const url = `https://signportal.${domain}.${tld}:${port}`;
      
      logger.debug("Generated portal URL", {
        component: "AuthStateManager",
        method: "getPortalUrl",
        serviceProviderId,
        url
      });
      
      return url;
    } catch (error) {
      logger.error("Error generating portal URL", {
        component: "AuthStateManager",
        method: "getPortalUrl",
        serviceProviderId,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }
  
  /**
   * Performs a fetch operation with comprehensive error handling and logging for Grafana monitoring
   *
   * @param {string} url - The URL to fetch from
   * @param {Object} options - Fetch options including method, headers, etc.
   * @returns {Promise<Object>} - The response data or error object
   */
  async fetchWithErrorHandling(url, options, retryCount = 0) {
    const requestId = ulid();
    const startTime = Date.now();
    const operation = options?.method || "GET";
    
    // Validate URL before proceeding
    if (!url) {
      const error = new Error("URL is undefined or empty");
      logger.error("Invalid URL for API request", {
        component: "AuthStateManager",
        method: "fetchWithErrorHandling",
        requestId,
        operation,
        error: error.message,
      });
      throw error;
    }
    
    // Extract endpoint for logging - handle both absolute and relative URLs
    let endpoint;
    try {
      // Check if it's an absolute URL
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const urlObj = new URL(url);
        endpoint = urlObj.pathname;
      } else {
        // It's a relative URL, just use it as the endpoint
        endpoint = url;
      }
    } catch (error) {
      logger.warn("Failed to parse URL", {
        component: "AuthStateManager",
        method: "fetchWithErrorHandling",
        requestId,
        url,
        error: error.message,
      });
      endpoint = url; // Fallback to using the raw URL for logging
    }

    logger.info("API request initiated", {
      component: "AuthStateManager",
      method: "fetchWithErrorHandling",
      requestId,
      url: endpoint,
      operation,
      retryCount,
    });

    try {
      // Get the current JWT token for authentication
      const jwt_token = this.getJwtToken();

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
          await this.setJwtToken(newToken);
          logger.debug("JWT token refreshed from header", {
            component: "AuthStateManager",
            method: "fetchWithErrorHandling",
            requestId,
          });
        } catch (tokenError) {
          logger.error("Failed to update JWT token", {
            component: "AuthStateManager",
            method: "fetchWithErrorHandling",
            requestId,
            error: tokenError.message,
          });
        }
      }

      // Log response metrics
      logger.info("API request completed", {
        component: "AuthStateManager",
        method: "fetchWithErrorHandling",
        requestId,
        url: endpoint,
        operation,
        status: response.status,
        responseTime,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("api_request_duration_ms", responseTime, {
        endpoint,
        operation,
        status: response.status,
      });

      // Handle 401 Unauthorized with retry for token expiration
      if (response.status === 401 && retryCount < 1) {
        const responseData = await response.json();

        // Only retry for expired tokens
        if (responseData.error === "token_expired") {
          logger.info("Token expired, refreshing and retrying", {
            component: "AuthStateManager",
            method: "fetchWithErrorHandling",
            requestId,
          });

          // Refresh token logic would go here
          // For now, just retry the request
          return this.fetchWithErrorHandling(url, options, retryCount + 1);
        }
      }

      // Check if response is OK (status 200-299)
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          errorData.message || `HTTP Error ${response.status}`
        );
        error.status = response.status;
        error.data = errorData;
        throw error;
      }

      // Parse and return response data
      const data = await response.json();
      return data;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      logger.error("API request failed", {
        component: "AuthStateManager",
        method: "fetchWithErrorHandling",
        requestId,
        url: endpoint,
        operation,
        error: error.message,
        stack: error.stack,
        responseTime,
      });

      // Emit metrics for Grafana dashboards
      logger.metric("api_request_duration_ms", responseTime, {
        endpoint,
        operation,
        status: "error",
      });
      logger.metric("api_request_errors_total", 1, {
        endpoint,
        operation,
        error: error.constructor.name,
      });

      throw error;
    }
  }
}

class RoditManager {
  // Private static instance - the only instance that will exist
  static #instance = null;
  
  // Public static method to get the instance
  static getInstance(blockchainService) {
    if (!RoditManager.#instance) {
      RoditManager.#instance = new RoditManager(blockchainService);
    }
    return RoditManager.#instance;
  }

  // Private constructor to prevent external instantiation
  constructor(blockchainService) {
    // Only allow instantiation if no instance exists
    if (RoditManager.#instance) {
      return RoditManager.#instance;
    }
    
    // Initialize properties
    this.stateManager = AuthStateManager.getInstance();
    this.vaultInitialized = false;
    this.vaultPath = null;
    this.credentials = {
      portal: null,
      sanctum: null,
      server: null,
      client: null,
    };
    this.blockchainService = blockchainService;
    
    // Store this instance
    RoditManager.#instance = this;
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
      return;
    }

    try {
      const {
        initializeProductionVault,
        setupTokenRenewal,
      } = require("./vaultsetup-production");

      // Initialize the vault
      await initializeProductionVault();

      // Set up token renewal
      await setupTokenRenewal();

      // Set initialization flags
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

      return; // No need to return anything
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error("Failed to initialize vault", {
        component: "RoditManager",
        method: "initializeVault",
        requestId,
        duration,
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
      logger.debug("Vault initialized successfully", {
        component: "RoditManager",
        method: "getCredentials",
        requestId,
        vaultPath: this.vaultPath,
        vaultInitialized: this.vaultInitialized,
      });
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

      const { get_rodit_fromvault } = require("./vaultsetup-production");

      const vaultData = await get_rodit_fromvault(
        null, // Replaced 'vault' with null since it's not used
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

      const accountState = await this.blockchainService.nearorg_rpc_state(
        
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
        constants: CONSTANTS.SMART_CONTRACT,
        requestId,
        accountId: account_id,
        step: "tokenFetch",
      });

      const own_rodit =
        await this.blockchainService.nearorg_rpc_tokensfromaccountid(
          
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
          apiendpoint: "localhost:" + SERVERPORT,
          port: SERVERPORT,
          iso639: API_OPTIONS.ISO639,
          iso3166: API_OPTIONS.ISO3166,
          iso15924: API_OPTIONS.ISO15924,
          timeoptions: API_OPTIONS.TIMEOPTIONS,
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
        iso639: API_OPTIONS.ISO639,
        iso3166: API_OPTIONS.ISO3166,
        iso15924: API_OPTIONS.ISO15924,
        timeoptions: API_OPTIONS.TIMEOPTIONS,
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

// Create a container for our instances
const instances = {};

// Create instances without circular dependencies
instances.blockchainService = new BlockchainService({
  CONSTANTS,
  NEAR_RPC_URL,
});

// Get singleton instances using the static getInstance methods
instances.stateManager = AuthStateManager.getInstance();
instances.roditManager = RoditManager.getInstance(instances.blockchainService);
instances.sessionManager = session;

// Import the classes
const TokenServiceClass = require("../auth/tokenservice");
const AuthenticationClass = require("../auth/authentication");
const AuthenticationMiddlewareClass = require("./authenticationmiddleware");

// Create service instances
instances.tokenService = new TokenServiceClass();
instances.authentication = new AuthenticationClass();
instances.authMiddleware = new AuthenticationMiddlewareClass();

// Initialize all services in the correct order
async function initializeServices() {
  const initializationContext = {
    component: "initializeServices",
    startTime: new Date().toISOString(),
  };

  try {
    logger.info("Initializing services...", initializationContext);

    // 1. Initialize blockchain service first
    if (instances.blockchainService.initialize) {
      logger.debug("Initializing blockchain service...", initializationContext);
      try {
        await instances.blockchainService.initialize();
        logger.debug(
          "Blockchain service initialized successfully",
          initializationContext
        );
      } catch (error) {
        logger.error("Failed to initialize blockchain service", {
          ...initializationContext,
          error: error.message,
          stack: error.stack,
        });
        throw new Error(
          `Blockchain service initialization failed: ${error.message}`
        );
      }
    }

    // 2. Initialize authentication services
    logger.debug(
      "Initializing authentication services...",
      initializationContext
    );
    try {
      await Promise.all([
        instances.authentication.initialize(instances),
        instances.tokenService.initialize(instances),
        instances.authMiddleware.initialize(instances),
      ]);
      logger.debug(
        "Authentication services initialized successfully",
        initializationContext
      );
    } catch (error) {
      logger.error("Failed to initialize authentication services", {
        ...initializationContext,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(
        `Authentication services initialization failed: ${error.message}`
      );
    }

    logger.info("All services initialized successfully", {
      ...initializationContext,
      endTime: new Date().toISOString(),
      duration: `${new Date() - new Date(initializationContext.startTime)}ms`,
    });

    return true;
  } catch (error) {
    const errorContext = {
      ...initializationContext,
      error: error.message,
      stack: error.stack,
      stateManager: instances.stateManager ? "initialized" : "not initialized",
      endTime: new Date().toISOString(),
      duration: `${new Date() - new Date(initializationContext.startTime)}ms`,
    };

    logger.error("Critical error during service initialization", errorContext);
    throw error;
  }
}

// Create function wrappers that use the singleton instances
const login_client = (req, res) => instances.authentication.login_client(req, res);
const logout_client = (req, res) => instances.authentication.logout_client(req, res);
const login_server = (own_rodit) => instances.authentication.login_server(own_rodit);
const login_portal = (own_rodit, port) => instances.authentication.login_portal(own_rodit, port);
const send_webhook = (event, data, isError, req) => instances.authentication.send_webhook(event, data, isError, req);
const authenticate_apicall = (req, res, next) => instances.authMiddleware.authenticate_apicall(req, res, next);
const authenticate_webhook = (req, res, next) => instances.authMiddleware.authenticate_webhook(req, res, next);

// Export the instances and initialization function
module.exports = {
  // Authentication functions
  login_client: instances.authentication.login_client.bind(instances.authentication),
  authenticate_apicall: instances.authMiddleware.authenticate_apicall.bind(instances.authMiddleware),
  
  // Singleton instances
  stateManager: instances.stateManager,
  roditManager: instances.roditManager,
  sessionManager: instances.sessionManager,
  
  // Services
  initializeServices,
  
  // Utility functions
  fetchWithErrorHandling: instances.stateManager.fetchWithErrorHandling.bind(instances.stateManager),
};
