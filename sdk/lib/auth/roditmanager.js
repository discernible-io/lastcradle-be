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


const baseModuleContext = createLogContext("ModuleLoader", "RoditManager", {
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

    const constructorContext = createLogContext("RoditManager", "constructor", {
      instanceId,
      hasExistingInstance: !!RoditManager.instance,
      existingInstanceId: RoditManager.instance ? RoditManager.instance._instanceId : null
    });
    
    logger.debugWithContext("RoditManager constructor called", constructorContext);
    if (RoditManager.instance) {
      logger.debugWithContext("Returning existing RoditManager instance", {
        ...constructorContext,
        instanceId: RoditManager.instance._instanceId
      });
      return RoditManager.instance;
    }

    this._instanceId = instanceId; // Store the instance ID
    logger.debug("Creating new RoditManager instance", {
      component: "RoditManager",
      instanceId: this._instanceId
    });

    this.stateManager = stateManager;

    RoditManager.instance = this;
  }

async initializeCredentialsStore() {
  const requestId = ulid();
  logger.debug("Initializing CredentialManager", {
    component: "RoditManager",
    method: "initializeCredentialsStore",
    requestId,
    instanceId: this._instanceId
  });
  
  try {
    const credentialstoreInstance = await initializeProductionCredentialStore();
    await setupTokenRenewal(credentialstoreInstance);
    
    logger.debug("CredentialStore initialization completed through CredentialManager", {
      component: "RoditManager",
      method: "initializeCredentialsStore",
      requestId,
      instanceId: this._instanceId
    });
    
    return credentialstoreInstance;
  } catch (error) {
    logger.error("Error during CredentialStore initialization", {
      component: "RoditManager",
      method: "initializeCredentialsStore",
      requestId,
      errorMessage: error.message,
      errorCode: error.code || "UNKNOWN_ERROR",
      stack: error.stack
    });
    
    throw error;
  }
}

  async getCredentials(type) {
    const requestId = ulid();
    
    const baseContext = createLogContext(
      "RoditManager", 
      "getCredentials",
      {
        requestId,
        credentialType: type
      }
    );
    
    logger.debugWithContext("Retrieving credentials through CredentialManager", baseContext);
    
    try {
      // Delegate credential retrieval to the CredentialManager
      const credentials = await getCredentials(type);
      
      logger.debugWithContext("Credentials retrieved through CredentialManager", {
        ...baseContext,
        hasCredentials: !!credentials
      });
      
      return credentials;
    } catch (error) {
      logErrorWithMetrics({
        error,
        context: {
          ...baseContext,
          errorCode: error.code || "UNKNOWN_ERROR"
        },
        metrics: [{
          name: "credential_retrieval_errors",
          value: 1,
          tags: { credentialType: type, errorCode: error.code || "UNKNOWN_ERROR" }
        }]
      });
      
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
    
    logger.infoWithContext("Starting RODiT config initialization", baseContext);

    try {
      logger.debugWithContext("Getting credentials", {
        ...baseContext,
        step: "fetchCredentials"
      });

      const credentials = await this.getCredentials(type);

      if (!credentials) {
        logErrorWithMetrics({
          error: new Error(`Credentials not available for ${type}`),
          context: {
            ...baseContext,
            step: "credentialCheck"
          },
          metrics: [{
            name: "credential_retrieval_failures",
            value: 1,
            tags: { configType: type }
          }]
        });
        throw new Error(`Credentials not available for ${type}`);
      }

      const { account_id, implicit_account_id } = credentials;
      logger.infoWithContext("Using account for initialization", {
        ...baseContext,
        accountId: account_id,
        step: "accountSetup"
      });

      logger.debugWithContext("Checking account state on blockchain", {
        ...baseContext,
        accountId: account_id,
        step: "blockchainCheck"
      });

      const accountState = await nearorg_rpc_state(
        account_id
      );

      if (!accountState) {
        logger.warnWithContext("Account has no balance in network", {
          ...baseContext,
          accountId: account_id,
          step: "blockchainCheck"
        });
      } else {
        logger.infoWithContext("Account state verified on blockchain", {
          ...baseContext,
          accountId: account_id,
          step: "blockchainCheck"
        });
      }

      logger.debugWithContext("Fetching RODiT tokens for account", {
        ...baseContext,
        accountId: account_id,
        step: "tokenFetch"
      });

      const own_rodit = await nearorg_rpc_tokensfromaccountid(
        account_id
      );

      // Check if we have a real RODiT token
      if (!own_rodit || !own_rodit.token_id) {
        logger.warnWithContext(
          "No RODiT instances found, proceeding with partial initialization",
          {
            ...baseContext,
            accountId: account_id,
            step: "tokenCheck"
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

        await this.stateManager.setConfigOwnRodit(minimalConfig);

        logger.debugWithContext("Converting implicit account ID to base64url", {
          ...baseContext,
          step: "keyConversion",
        });

        logger.debugWithContext("Setting session base64url JWK public key", {
          ...baseContext,
          step: "setSessionKey",
        });

        await this.stateManager.setOwnBase64urlJwkPublicKey(
          session_base64url_jwk_public_key
        );

        const duration = Date.now() - startTime;
        logger.infoWithContext("RODiT config initialized with minimal configuration", {
          ...baseContext,
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

      logger.infoWithContext("RODiT config initialized successfully", {
        ...baseContext,
        roditId: own_rodit.token_id,
        duration: Date.now() - startTime
      });

      const SERVERPORT = config.get("SERVERPORT");

      if (
        !own_rodit.metadata ||
        !own_rodit.metadata.subjectuniqueidentifier_url
      ) {
        logger.errorWithContext("Missing required metadata in RODiT", {
          ...baseContext,
          missingField: "subjectuniqueidentifier_url",
          step: "metadataCheck",
        });

        throw new Error(
          "Missing required metadata: subjectuniqueidentifier_url"
        );
      }

      const apiendpoint =
        own_rodit.metadata.subjectuniqueidentifier_url + ":" + SERVERPORT;

      logger.debugWithContext("Constructed API endpoint", {
        ...baseContext,
        apiEndpoint: apiendpoint,
        step: "apiEndpointCreation",
      });

      logger.infoWithContext("Building full configuration object", {
        ...baseContext,
        step: "fullConfigCreation",
      });

      // Validate private key format before storing in config object
      let privateKeyToUse = credentials.signing_bytes_key;
      
      // Detailed private key format validation and logging
      logger.debugWithContext("Private key format validation", {
        ...baseContext,
        keyType: typeof privateKeyToUse,
        isUint8Array: privateKeyToUse instanceof Uint8Array,
        isBuffer: Buffer.isBuffer(privateKeyToUse),
        length: privateKeyToUse?.length,
        step: "privateKeyValidation"
      });
      
      // Ensure private key is in the correct format (Uint8Array)
      if (privateKeyToUse && !(privateKeyToUse instanceof Uint8Array)) {
        if (Buffer.isBuffer(privateKeyToUse)) {
          logger.debugWithContext("Converting Buffer to Uint8Array for private key", {
            ...baseContext,
            step: "privateKeyConversion"
          });
          privateKeyToUse = new Uint8Array(privateKeyToUse);
        } else {
          logErrorWithMetrics({
            error: new Error("Private key must be a Uint8Array or Buffer"),
            context: {
              ...baseContext,
              keyType: typeof privateKeyToUse,
              step: "privateKeyValidation"
            },
            metrics: [{
              name: "private_key_format_errors",
              value: 1,
              tags: { configType: type }
            }]
          });
          throw new Error("Private key must be a Uint8Array or Buffer");
        }
      }
      
      const configObject = {
        own_rodit,
        own_rodit_bytes_private_key: privateKeyToUse, // Use validated private key
        apiendpoint,
        port: SERVERPORT,
        iso639: config.get("API_DEFAULT_OPTIONS.ISO639"),
        iso3166: config.get("API_DEFAULT_OPTIONS.ISO3166"),
        iso15924: config.get("API_DEFAULT_OPTIONS.ISO15924"),
        timeoptions: config.get("API_DEFAULT_OPTIONS.TIMEOPTIONS"),
        tokenrenewaloptions: config.get("API_DEFAULT_OPTIONS.TOKENRENEWALOPTIONS"),
      };

      logger.debugWithContext("Using RODiT token for configuration", {
        ...baseContext,
        roditId: own_rodit.token_id,
        accountId: account_id,
        step: "tokenUse"
      });

      logger.debugWithContext("Storing configuration in state manager", {
        ...baseContext,
        step: "storeConfig",
      });

      await this.stateManager.setConfigOwnRodit(configObject);

      logger.infoWithContext("Configuration stored successfully", {
        ...baseContext,
        step: "configStored",
      });

      logger.debugWithContext("Converting implicit account ID to base64url", {
        ...baseContext,
        step: "keyConversion",
      });

      const session_base64url_jwk_public_key = Buffer.from(
        implicit_account_id,
        "hex"
      ).toString("base64url");

      logger.debugWithContext("Setting session base64url JWK public key", {
        ...baseContext,
        step: "setSessionKey",
      });

      // Set the client's own public key from the implicit account ID
      await this.stateManager.setOwnBase64urlJwkPublicKey(
        session_base64url_jwk_public_key
      );
      
      // Note: The server's public key should be set separately when it's received
      // during the handshake or authentication process

      const duration = Date.now() - startTime;
      logger.infoWithContext("RODiT configuration completed", {
        ...baseContext,
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

      logErrorWithMetrics({
        error,
        context: {
          ...baseContext,
          duration
        },
        metrics: [{
          name: "rodit_config_initialization_errors",
          value: 1,
          tags: { configType: type, errorType: error.name || "Unknown" }
        }]
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

// Create and export a singleton instance
const roditManager = new RoditManager();

// Export the singleton instance directly to avoid any issues with destructuring
module.exports = roditManager;
