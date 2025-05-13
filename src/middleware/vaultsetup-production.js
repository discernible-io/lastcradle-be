const config = require("config");
const bs58 = require("bs58");
const logger = require("../../config/logger");

class ProductionVaultManager {
  constructor() {
    this._vault = require("node-vault")();
    this._vault.endpoint = config.get("VAULT_ENDPOINT");
    this._vault.apiVersion = "v1";
    this.roleId = config.get("VAULT_ROLE_ID");
    this.secretId = config.get("VAULT_SECRET_ID");
    this.renewalInterval = 60 * 60 * 1000; // 1 hour in milliseconds
    this.initialized = false;
  }

  // Add a getter for direct vault access
  get vault() {
    return this._vault;
  }

  async getProductionVaultToken() {
    try {
      const result = await this._vault.approleLogin({
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
    if (this.initialized) {
      return this._vault;
    }
    
    try {
      const token = await this.getProductionVaultToken();
      this._vault.token = token;

      const health = await this._vault.health();
      if (!health.initialized) {
        throw new Error("Error 109: Vault is not initialized");
      }
      if (health.sealed) {
        throw new Error("Error 110: Vault is sealed");
      }

      this.initialized = true;
      return this._vault;
    } catch (error) {
      logger.error("Error initializing production Vault:", error);
      throw error;
    }
  }

  async setupTokenRenewal() {
    try {
      setInterval(async () => {
        try {
          const token = await this.getProductionVaultToken();
          this._vault.token = token;
        } catch (error) {
          logger.error("Error renewing Vault token:", error);
        }
      }, this.renewalInterval);
    } catch (error) {
      logger.error("Error setting up token renewal:", error);
    }
  }

  async getRoditFromVault(vaultPath, secretKey) {
    // Use this._vault instead of vault parameter
    this.validateVaultParameters(vaultPath, secretKey);

    try {
      const result = await this._vault.read(`secret/data/${vaultPath}`);
      const secretData = result.data.data[secretKey];

      if (!secretData) {
        throw new Error(
          `Error 048: No data found for ${secretKey} at secret/data/${vaultPath}`
        );
      }

      const parsedData = this.parseSecretData(secretData, secretKey);
      return this.validateAndExtractCredentials(parsedData);
    } catch (error) {
      logger.error("Error retrieving Rodit config from Vault:", error);
      throw error;
    }
  }

  // Keep the rest of your methods the same, but replace any references to 
  // `this.vault` with `this._vault`
  validateVaultParameters(vaultPath, secretKey) {
    if (!this._vault || typeof this._vault.read !== "function") {
      throw new Error("Error 051: Invalid vault object");
    }
    if (!vaultPath || typeof vaultPath !== "string") {
      throw new Error("Error 052: Invalid VAULT_RODIT_KEYVALUE_PATH");
    }
    if (!secretKey || typeof secretKey !== "string") {
      throw new Error("Error 047: Invalid or missing secretKey parameter");
    }
  }

  // Rest of your existing methods...
  parseSecretData(secretData, secretKey) { /* existing code */ }
  validateAndExtractCredentials(parsedData) { /* existing code */ }
}

// Create a singleton instance
const vaultManager = new ProductionVaultManager();

// Export the manager, its methods, and direct vault property
module.exports = {
  initializeProductionVault: () => vaultManager.initialize(),
  get_rodit_fromvault: (_, path, secretKey) => 
    vaultManager.getRoditFromVault(path, secretKey),
  setupTokenRenewal: () => vaultManager.setupTokenRenewal(),
  vault: vaultManager.vault,  // Direct export of vault property
  vaultManager  // Export the manager itself if needed
};