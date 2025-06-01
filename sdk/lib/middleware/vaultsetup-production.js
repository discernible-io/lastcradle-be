const config = require("config");
const bs58 = require("bs58");
const { ulid } = require("ulid");
const logger = require("../../../config/logger");

logger.debug("Loading vaultsetup-production.js module", {
  component: "ModuleLoader",
  module: "vaultsetup-production.js",
  loadedAt: new Date().toISOString()
});

class ProductionVaultManager {
  constructor() {
    this.vault = require("node-vault")();
    this.vault.endpoint = config.get("VAULT_ENDPOINT");
    this.vault.apiVersion = "v1";
    this.roleId = config.get("VAULT_ROLE_ID");
    this.secretId = config.get("VAULT_SECRET_ID");
    this.renewalInterval = 60 * 60 * 1000; // 1 hour in milliseconds
    this.vaultInitialized = false;
    this.vaultPath = null;
    this.credentials = {};
  }

  async getProductionVaultToken() {
    try {
      const result = await this.vault.approleLogin({
        role_id: this.roleId,
        secret_id: this.secretId,
      });
      return result.auth.client_token;
    } catch (error) {
      logger.error("Error authenticating with Vault:", error);
      throw new Error("Error 108: Vault authentication failed");
    }
  }

  async initialize() {
    const requestId = ulid();
    const startTime = Date.now();

    logger.debug("Starting vault initialization", {
      component: "VaultManager",
      method: "initialize",
      requestId
    });

    if (this.vaultInitialized) {
      logger.debug("Vault already initialized", {
        component: "VaultManager",
        method: "initialize",
        requestId
      });
      return this.vault;
    }

    try {
      const token = await this.getProductionVaultToken();
      this.vault.token = token;

      const health = await this.vault.health();
      if (!health.initialized) {
        throw new Error("Error 109: Vault is not initialized");
      }
      if (health.sealed) {
        throw new Error("Error 110: Vault is sealed");
      }

      try {
        // Check if config is available and has the required path
        if (config && typeof config.get === 'function') {
          this.vaultPath = config.get("VAULT_RODIT_KEYVALUE_PATH");
          logger.debug("Retrieved vault path from config", {
            component: "VaultManager",
            method: "initialize",
            requestId,
            vaultPath: this.vaultPath
          });
        } else {
          const error = new Error("Config object is not properly initialized");
          logger.error("Vault initialization failed - configuration error", {
            component: "VaultManager",
            method: "initialize",
            requestId,
            errorMessage: error.message,
            errorCode: "CONFIG_INITIALIZATION_ERROR"
          });
          throw error;
        }
      } catch (configError) {
        // Reset the vaultInitialized flag since initialization failed
        this.vaultInitialized = false;
        
        logger.error("Vault initialization failed - configuration error", {
          component: "VaultManager",
          method: "initialize",
          requestId,
          errorMessage: configError.message,
          errorCode: "CONFIG_ACCESS_ERROR",
          stack: configError.stack
        });
        
        // Rethrow the error to prevent continuing with invalid configuration
        throw configError;
      }

      this.vaultInitialized = true;

      logger.debug("Vault initialization flags set", {
        component: "VaultManager",
        method: "initialize",
        requestId,
        vaultInitialized: this.vaultInitialized,
        vaultPath: this.vaultPath
      });

      const duration = Date.now() - startTime;
      logger.info("Vault initialized successfully", {
        component: "VaultManager",
        method: "initialize",
        requestId,
        duration,
        status: "success"
      });

      return this.vault;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error("Vault initialization failed", {
        component: "VaultManager",
        method: "initialize",
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
        component: "VaultManager",
        errorType: error.code || "UNKNOWN_ERROR",
      });
      logger.metric("vault_initialization_errors_total", 1, {
        errorType: error.code || "UNKNOWN_ERROR",
        component: "VaultManager",
      });

      throw error;
    }
  }

  async setupTokenRenewal() {
    try {
      // Get token info to determine TTL
      const tokenInfo = await this.vault.tokenLookupSelf();
      const ttlSeconds = tokenInfo.data.ttl;
      
      // Calculate renewal time (renew at 80% of TTL)
      const renewalTimeMs = (ttlSeconds * 0.8) * 1000;
      
      logger.info("Setting up token renewal", {
        component: "VaultManager",
        ttlSeconds,
        renewalIntervalMs: renewalTimeMs || this.renewalInterval,
        nextRenewalAt: new Date(Date.now() + (renewalTimeMs || this.renewalInterval)).toISOString()
      });
      
      // Use calculated renewal time or fall back to default
      const interval = renewalTimeMs || this.renewalInterval;
      
      setInterval(async () => {
        try {
          logger.debug("Attempting to renew Vault token", {
            component: "VaultManager",
            method: "tokenRenewal"
          });
          
          // Use proper token renewal instead of re-authenticating
          const renewResponse = await this.vault.tokenRenew();
          
          logger.info("Successfully renewed Vault token", {
            component: "VaultManager",
            method: "tokenRenewal",
            newTtl: renewResponse.auth?.lease_duration || "unknown"
          });
        } catch (error) {
          logger.error("Error renewing Vault token, attempting re-authentication", {
            component: "VaultManager",
            method: "tokenRenewal",
            errorMessage: error.message
          });
          
          try {
            // Fall back to re-authentication if renewal fails
            const token = await this.getProductionVaultToken();
            this.vault.token = token;
            
            logger.info("Successfully re-authenticated with Vault", {
              component: "VaultManager",
              method: "tokenRenewal"
            });
          } catch (reAuthError) {
            logger.error("Failed to re-authenticate with Vault", {
              component: "VaultManager",
              method: "tokenRenewal",
              errorMessage: reAuthError.message
            });
          }
        }
      }, interval);
    } catch (error) {
      logger.error("Error setting up token renewal", {
        component: "VaultManager",
        errorMessage: error.message
      });
      
      // Fall back to default renewal interval if we can't get token info
      setInterval(async () => {
        try {
          const token = await this.getProductionVaultToken();
          this.vault.token = token;
          
          logger.info("Successfully refreshed Vault token", {
            component: "VaultManager",
            method: "tokenRenewal"
          });
        } catch (refreshError) {
          logger.error("Error refreshing Vault token", {
            component: "VaultManager",
            method: "tokenRenewal",
            errorMessage: refreshError.message
          });
        }
      }, this.renewalInterval);
    }
  }

  async getRoditFromVault(vaultPath, secretKey) {
    this.validateVaultParameters(vaultPath, secretKey);

    try {
      logger.debug("¬", {
        path: `secret/data/${vaultPath}`,
        secretKey,
        endpoint: this.vault.endpoint,
        hasToken: !!this.vault.token,
      });
      const result = await this.vault.read(`secret/data/${vaultPath}`);
      const secretData = result.data.data[secretKey];

      if (!secretData) {
        throw new Error(
          `Error 048: No data found for ${secretKey} at secret/data/${vaultPath}`
        );
      }

      const parsedData = this.parseSecretData(secretData, secretKey);
      return this.validateAndExtractCredentials(parsedData);
    } catch (error) {
      logger.error("Error retrieving Rodit config from Vault:", {
        path: `secret/data/${vaultPath}`,
        secretKey,
        errorMessage: error.message,
        errorDetails: error.response?.data || error.response || "No details available",
        statusCode: error.response?.statusCode,
      });
      throw error;
    }
  }

  validateVaultParameters(vaultPath, secretKey) {
    if (!this.vault || typeof this.vault.read !== "function") {
      throw new Error("Error 051: Invalid vault object");
    }
    if (!vaultPath || typeof vaultPath !== "string") {
      throw new Error("Error 052: Invalid VAULT_RODIT_KEYVALUE_PATH");
    }
    if (!secretKey || typeof secretKey !== "string") {
      throw new Error("Error 047: Invalid or missing secretKey parameter");
    }
  }

  parseSecretData(secretData, secretKey) {
    if (typeof secretData === "string") {
      try {
        return JSON.parse(secretData);
      } catch (parseError) {
        throw new Error(`Error 046: Invalid JSON format in ${secretKey}`);
      }
    }
    return secretData;
  }

  validateAndExtractCredentials(parsedData) {
    logger.error("parsedData", parsedData);
    
    const stripEd25519Prefix = (key) => key.replace("ed25519:", "");
    
    const publicKeyToImplicitId = (publicKey) => {
      const publicKeyBase58 = stripEd25519Prefix(publicKey);
      const publicKeyBytes = bs58.decode(publicKeyBase58);
      return Buffer.from(publicKeyBytes.buffer).toString('hex');
    };
  
    if (parsedData.implicit_account_id) {
      const { implicit_account_id, private_key, public_key } = parsedData;
      
      if (!implicit_account_id || typeof implicit_account_id !== "string") {
        throw new Error("Error 244: Invalid or missing implicit_account_id value");
      }
      
      if (!private_key || typeof private_key !== "string") {
        throw new Error("Error 043: Invalid or missing private_key value");
      }
  
      if (public_key) {
        const calculatedImplicitId = publicKeyToImplicitId(public_key);
        if (implicit_account_id !== calculatedImplicitId) {
          throw new Error("Error 246: implicit_account_id does not match public_key");
        }
      }
  
      return {
        account_id: implicit_account_id, // Use implicit_account_id as account_id
        implicit_account_id,
        private_key: stripEd25519Prefix(private_key)
      };
    }
  
    const { account_id, public_key, private_key } = parsedData;
    
    if (!account_id || typeof account_id !== "string") {
      throw new Error("Error 244: Invalid or missing account_id value");
    }
    
    if (!public_key || typeof public_key !== "string") {
      throw new Error("Error 245: Invalid or missing public_key value");
    }
    
    if (!private_key || typeof private_key !== "string") {
      throw new Error("Error 043: Invalid or missing private_key value");
    }
  
    return {
      account_id,
      implicit_account_id: publicKeyToImplicitId(public_key),
      private_key: stripEd25519Prefix(private_key)
    };
  }
  
  async getCredentials(type) {
    const requestId = ulid();
    const startTime = Date.now();
    const maxRetries = 2; // Maximum number of retry attempts
    let retryCount = 0;
    let lastError = null;

    logger.debug("Retrieving credentials", {
      component: "VaultManager",
      method: "getCredentials",
      requestId,
      credentialType: type,
    });

    // Use cached credentials if available
    if (this.credentials[type]) {
      logger.debug("Using cached credentials", {
        component: "VaultManager",
        method: "getCredentials",
        requestId,
        credentialType: type,
      });
      return this.credentials[type];
    }

    // Make sure vault is initialized
    if (!this.vaultInitialized) {
      logger.debug("Vault not initialized, initializing now", {
        component: "VaultManager",
        method: "getCredentials",
        requestId,
      });
      await this.initialize();
    }

    // Retry logic for vault operations
    while (retryCount <= maxRetries) {
      try {
        // Make the accountType consistent with the type parameter
        const accountType = `account_${type}`;
        const vaultPath = `${this.vaultPath}/${type}`;

        logger.debug("Fetching credentials from vault", {
          component: "VaultManager",
          method: "getCredentials",
          requestId,
          credentialType: type,
          vaultPath,
          attempt: retryCount + 1,
          maxAttempts: maxRetries + 1
        });

        const vaultData = await this.getRoditFromVault(
          vaultPath,
          accountType
        );

        // Add detailed logging about the vault data received
        logger.debug("Vault data received", {
          component: "VaultManager",
          method: "getCredentials",
          requestId,
          credentialType: type,
          hasVaultData: !!vaultData,
          dataKeys: vaultData ? Object.keys(vaultData) : [],
          hasPrivateKey: vaultData && !!vaultData.private_key
        });

        // Safely check for private_key before using it
        if (!vaultData || !vaultData.private_key || typeof vaultData.private_key !== "string") {
          const error = new Error(`Invalid or missing private_key for ${type}`);
          logger.warn("Invalid private key format", {
            component: "VaultManager",
            method: "getCredentials",
            requestId,
            credentialType: type,
            privateKeyType: vaultData ? typeof vaultData.private_key : 'undefined',
            attempt: retryCount + 1
          });
          
          // Store error for potential retry
          lastError = error;
          
          // If we've reached max retries, throw the error
          if (retryCount >= maxRetries) {
            throw error;
          }
          
          // Otherwise retry
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
          continue;
        }

        const privateKeyStr = vaultData.private_key.startsWith("ed25519:")
          ? vaultData.private_key.replace("ed25519:", "")
          : vaultData.private_key;

        vaultData.signing_bytes_key = new Uint8Array(bs58.decode(privateKeyStr));
        this.credentials[type] = vaultData;

        const duration = Date.now() - startTime;
        logger.info("Credentials retrieved successfully", {
          component: "VaultManager",
          method: "getCredentials",
          requestId,
          credentialType: type,
          duration,
          accountId: vaultData.account_id, // Safe to log account ID
          attempt: retryCount + 1
        });

        // Emit metrics for Grafana dashboards
        logger.metric("credential_retrieval_duration_ms", duration, {
          success: true,
          credentialType: type,
          component: "VaultManager"
        });

        return vaultData;
      } catch (error) {
        lastError = error;
        
        // Log the error but don't throw yet if we have retries left
        const isRetrying = retryCount < maxRetries;
        const logLevel = isRetrying ? "warn" : "error";
        const duration = Date.now() - startTime;
        
        logger[logLevel](`${isRetrying ? "Retryable error" : "Failed"} retrieving credentials`, {
          component: "VaultManager",
          method: "getCredentials",
          requestId,
          credentialType: type,
          duration,
          errorMessage: error.message,
          errorCode: error.code || "UNKNOWN_ERROR",
          stack: error.stack,
          attempt: retryCount + 1,
          willRetry: isRetrying
        });
        
        // Emit metrics for Grafana dashboards
        logger.metric("credential_retrieval_duration_ms", duration, {
          success: false,
          credentialType: type,
          errorType: error.code || "UNKNOWN_ERROR",
          component: "VaultManager",
          retryAttempt: retryCount
        });
        
        if (isRetrying) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // Exponential backoff
          continue;
        }
        
        // If we've exhausted retries, throw the last error
        logger.metric("credential_retrieval_errors_total", 1, {
          credentialType: type,
          errorType: error.code || "UNKNOWN_ERROR",
          component: "VaultManager"
        });
        
        throw lastError;
      }
    }
  }
}

const vaultManager = new ProductionVaultManager();

module.exports = {
  initializeProductionVault: () => vaultManager.initialize(),
  get_rodit_fromvault: (vault, path, secretKey) =>
    vaultManager.getRoditFromVault(path, secretKey),
  setupTokenRenewal: () => vaultManager.setupTokenRenewal(),
  getCredentials: (type) => vaultManager.getCredentials(type),
  vault: vaultManager.vault,
};
