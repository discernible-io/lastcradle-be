// Copyright (c) 2024 Ayayai, Inc. All rights reserved.

/**
 * RODiT Manager Service
 * Responsible for managing RODiT configurations, credentials, interactions
 */

const { ulid } = require("ulid");
const config = require("config");
const logger = require("../../services/logger");
const { createLogContext, logErrorWithMetrics } = logger;
const {
  initializeProductionCredentialStore,
  setupTokenRenewal,
  getCredentials,
  vault,
} = require("../middleware/vaultcredentialstore");
const {
  nearorg_rpc_state,
  nearorg_rpc_tokensfromaccountid,
  CONSTANTS,
} = require("../blockchain/blockchainservice");
const stateManager = require("../blockchain/statemanager");


const baseModuleContext = createLogContext("ModuleLoader", "roditmanager", {
  loadedAt: new Date().toISOString()
});

logger.debugWithContext("Loading roditmanager.js module", baseModuleContext);
/**
 * RoditManager class
 * Singleton class for managing RODiT configurations and credentials
 */
class RoditManager {
  constructor() {
    const instanceId = ulid();
    
    const baseContext = createLogContext("RoditManager", "constructor", {
      instanceId,
      hasExistingInstance: !!RoditManager.instance,
      existingInstanceId: RoditManager.instance ? RoditManager.instance._instanceId : null
    });
    
    logger.debugWithContext("RoditManager constructor called", baseContext);
    
    if (RoditManager.instance) {
      logger.debugWithContext("Returning existing RoditManager instance", {
        ...baseContext,
        instanceId: RoditManager.instance._instanceId
      });
      return RoditManager.instance;
    }

    this._instanceId = instanceId; // Store the instance ID
    logger.infoWithContext("Creating new RoditManager instance", {
      ...baseContext,
      instanceId: this._instanceId
    });

    this.stateManager = stateManager;

    RoditManager.instance = this;
  }

async initializeCredentialsStore() {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext(
    "RoditManager",
    "initializeCredentialsStore",
    {
      requestId,
      instanceId: this._instanceId
    }
  );
  
  logger.infoWithContext("Initializing CredentialManager", baseContext);
  
  try {
    const credentialstoreInstance = await initializeProductionCredentialStore();
    await setupTokenRenewal(credentialstoreInstance);
    
    const duration = Date.now() - startTime;
    
    logger.infoWithContext("CredentialStore initialization completed", {
      ...baseContext,
      duration
    });
    
    // Emit metrics for Grafana dashboards
    logger.metric("credential_store_initialization_ms", duration, {
      component: "RoditManager",
      success: true
    });
    
    return credentialstoreInstance;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Emit metrics for Grafana dashboards
    logger.metric("credential_store_initialization_ms", duration, {
      component: "RoditManager",
      success: false,
      error: error.name || "Unknown"
    });
    logger.metric("credential_store_errors_total", 1, {
      component: "RoditManager",
      error_type: error.name || "Unknown"
    });
    
    logErrorWithMetrics(
      "Error during CredentialStore initialization", 
      {
        ...baseContext,
        duration,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR"
      },
      error,
      "credential_store_initialization",
      {
        result: "error",
        error_type: error.name || "Unknown",
        duration
      }
    );
    
    throw error;
  }
}

  async getCredentials(type) {
    const requestId = ulid();
    const startTime = Date.now();
    
    const baseContext = createLogContext(
      "RoditManager",
      "getCredentials",
      {
        requestId,
        credentialType: type
      }
    );
    
    logger.debugWithContext("Retrieving credentials", baseContext);
    
    try {
      // Delegate credential retrieval to the CredentialManager
      const credentials = await getCredentials(type);
      
      const duration = Date.now() - startTime;
      
      logger.debugWithContext("Credentials retrieved successfully", {
        ...baseContext,
        duration,
        hasCredentials: !!credentials
      });
      
      // Emit metrics for Grafana dashboards
      logger.metric("credential_retrieval_ms", duration, {
        component: "RoditManager",
        success: true,
        credentialType: type
      });
      
      return credentials;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Emit metrics for Grafana dashboards
      logger.metric("credential_retrieval_ms", duration, {
        component: "RoditManager",
        success: false,
        credentialType: type,
        error: error.name || "Unknown"
      });
      logger.metric("credential_retrieval_errors_total", 1, {
        component: "RoditManager",
        credentialType: type,
        error_type: error.name || "Unknown"
      });
      
      logErrorWithMetrics(
        "Error retrieving credentials", 
        {
          ...baseContext,
          duration,
          errorMessage: error.message,
          errorCode: error.code || "UNKNOWN_ERROR"
        },
        error,
        "credential_retrieval",
        {
          result: "error",
          error_type: error.name || "Unknown",
          credentialType: type,
          duration
        }
      );
      
      throw error;
    }
  }

  async initializeRoditConfig(type) {
    const requestId = ulid();
    const startTime = Date.now();
    
    // Create a base context for this method
    const baseContext = createLogContext(
      "RoditManager",
      "initializeRoditConfig",
      { 
        requestId,
        configType: type
      }
    );

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
          iso639: config.get("API_DEFAULT_OPTIONS.ISO639"),
          iso3166: config.get("API_DEFAULT_OPTIONS.ISO3166"),
          iso15924: config.get("API_DEFAULT_OPTIONS.ISO15924"),
          timeoptions: config.get("API_DEFAULT_OPTIONS.TIMEOPTIONS"),
          tokenrenewaloptions: config.get("API_DEFAULT_OPTIONS.TOKENRENEWALOPTIONS"),
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
        iso639: config.get("API_DEFAULT_OPTIONS.ISO639"),
        iso3166: config.get("API_DEFAULT_OPTIONS.ISO3166"),
        iso15924: config.get("API_DEFAULT_OPTIONS.ISO15924"),
        timeoptions: config.get("API_DEFAULT_OPTIONS.TIMEOPTIONS"),
        tokenrenewaloptions: config.get("API_DEFAULT_OPTIONS.TOKENRENEWALOPTIONS"),
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

      // Set the client's own public key from the implicit account ID
      await this.stateManager.setOwnBase64urlJwkPublicKey(
        session_base64url_jwk_public_key
      );
      
      // Note: The server's public key should be set separately when it's received
      // during the handshake or authentication process

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

      const errorContext = {
        ...baseContext,
        duration,
        configType: type,
        errorMessage: error.message,
        errorCode: error.code || "UNKNOWN_ERROR",
        step: error.step || "unknown"
      };
      
      logErrorWithMetrics(
        "Error initializing RODiT config",
        errorContext,
        error,
        "rodit_initialization",
        {
          result: "error",
          error_type: error.code || "UNKNOWN_ERROR",
          configType: type,
          step: error.step || "unknown",
          duration
        }
      );

      throw error;
    }
  }
}

// Create and export a singleton instance
const roditManager = new RoditManager();

// Export the singleton instance directly to avoid any issues with destructuring
module.exports = roditManager;
