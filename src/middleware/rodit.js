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

const API_OPTIONS = config.get("API_OPTIONS");
const SERVERPORT = config.get("SERVERPORT");
const NEAR_RPC_URL = config.get("NEAR_RPC_URL");

/**
 * Singleton State Management Classes
 */
class AuthStateManager {
  constructor() {
    if (AuthStateManager.instance) {
      return AuthStateManager.instance;
    }

    // Separate variables for own key and peer key
    this.ownBase64urlJwkPublicKey = null;
    this.peerBase64urlJwkPublicKey = null;

    // Other existing properties
    this.configOwnRodit = null;
    this.currentToken = null;
    this.jwtToken = null;

    AuthStateManager.instance = this;
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

  // Existing methods remain unchanged
  async setConfigOwnRodit(config_own_rodit) {
    this.configOwnRodit = config_own_rodit;
    return config_own_rodit;
  }

  getConfigOwnRodit() {
    return this.configOwnRodit;
  }

  async setCurrentToken(token) {
    this.currentToken = token;
    return token;
  }

  getCurrentToken() {
    return this.currentToken;
  }

  async setJwtToken(token) {
    this.jwtToken = token;
    return token;
  }

  getJwtToken() {
    return this.jwtToken;
  }

  getPortalUrl(serviceProviderId, port) {
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
}

class RoditManager {
  constructor(blockchainService) {
    if (RoditManager.instance) {
      return RoditManager.instance;
    }

    this.stateManager = new AuthStateManager();
    this.vaultInitialized = false;
    this.vaultPath = null;
    this.blockchainService = blockchainService; // Store blockchainService
    this.credentials = {
      portal: null,
      sanctum: null,
      server: null,
      client: null,
    };
    this.config = config;
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
      this.vaultPath = this.config.get("VAULT_RODIT_KEYVALUE_PATH");

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
        CONSTANTS.SMART_CONTRACT,
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

      const own_rodit =
        await this.blockchainService.nearorg_rpc_tokensfromaccountid(
          CONSTANTS.SMART_CONTRACT,
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

instances.stateManager = new AuthStateManager();
instances.roditManager = new RoditManager(instances.blockchainService);
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

// Export the instances and initialization function
module.exports = {
  // Core instances
  ...instances,

  // Initialization function
  initializeServices,

  // Constants
  CONSTANTS,

  // Class definitions for backward compatibility
  AuthStateManager,
  RoditManager,

  // Authentication functions (maintain backward compatibility)
  login_client: (req, res) => instances.authentication.login_client(req, res),
  logout_client: (req, res) => instances.authentication.logout_client(req, res),
  login_server: (own_rodit) => instances.authentication.login_server(own_rodit),
  login_portal: (own_rodit, port) =>
    instances.authentication.login_portal(own_rodit, port),
  login_client_withnep413: (req, res, config_own_rodit) =>
    instances.authentication.login_client_withnep413(
      req,
      res,
      config_own_rodit
    ),

  // Token functions
  generate_jwt_token: (
    peer_rodit,
    peer_timestamp,
    own_rodit,
    own_rodit_bytes_private_key,
    session_status
  ) =>
    instances.tokenService.generate_jwt_token(
      peer_rodit,
      peer_timestamp,
      own_rodit,
      own_rodit_bytes_private_key,
      session_status
    ),

  // Middleware
  authenticate_apicall: (req, res, next) =>
    instances.authMiddleware.authenticate_apicall(req, res, next),

  // Webhook functions
  send_webhook: (event, data, isError, req) =>
    instances.authentication.send_webhook(event, data, isError, req),
  authenticate_webhook: (
    payload,
    signature_hex_ofpayload,
    timestamp,
    peer_rodit_owner_id
  ) =>
    instances.authentication.authenticate_webhook(
      payload,
      signature_hex_ofpayload,
      timestamp,
      peer_rodit_owner_id
    ),

  // Blockchain functions
  nearorg_rpc_state: (id, accountId) =>
    instances.blockchainService.nearorg_rpc_state(id, accountId),
  nearorg_rpc_tokensfromaccountid: (id, account_id) =>
    instances.blockchainService.nearorg_rpc_tokensfromaccountid(id, account_id),
  nearorg_rpc_fetchpublickeybytes: (accountId) =>
    instances.blockchainService.nearorg_rpc_fetchpublickeybytes(accountId),
  nearorg_rpc_tokenfromroditid: (roditid) =>
    instances.blockchainService.nearorg_rpc_tokenfromroditid(roditid),
  nearorg_rpc_timestamp: () =>
    instances.blockchainService.nearorg_rpc_timestamp(),

  // Token service functions
  base64url2jwk_public_key: (base64url_public_key) =>
    instances.tokenService.base64url2jwk_public_key(base64url_public_key),

  // Utility functions from utils/index.js
  debugWithType: utils.debugWithType,
  ensureDateIsSet: utils.ensureDateIsSet,
  base64ToBase64Url: utils.base64ToBase64Url,
  canonicalizeObject: utils.canonicalizeObject,
  calculateCanonicalHash: utils.calculateCanonicalHash,
  logServerBufferState: utils.logServerBufferState,
  fetchWithErrorHandling: utils.fetchWithErrorHandling,

  // Validation functions from validators/index.js
  validateAndSetUrl: validators.validateAndSetUrl,
  validateAndSetDate: validators.validateAndSetDate,
  validateAndSetJson: validators.validateAndSetJson,
  validateAndSetSignature: validators.validateAndSetSignature,
};
