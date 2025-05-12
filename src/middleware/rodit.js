/**
 * Integration layer for backward compatibility with existing code
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const config = require("config");
const logger = require("../../config/logger");
const Authentication = require('../auth/authentication');
const TokenService = require('../auth/tokenservice');
const BlockchainService = require('../blockchain/blockchainservice');
const AuthenticationMiddleware = require('./authenticationmiddleware');
const session = require('../auth/sessionmanager');
const { CONSTANTS, API_OPTIONS, SERVERPORT, API_PROTOCOL, NEAR_RPC_URL, TOKEN_RENEWAL_OPTIONS } = require('../utils/constants');
const validators = require('../validators');
const utils = require('../utils');

// Copy the class definitions from initialrodit.js
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
  async setConfigOwnRodit(config) {
    this.configOwnRodit = config;
    return config;
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
  constructor() {
    if (RoditManager.instance) {
      return RoditManager.instance;
    }

    this.stateManager = new AuthStateManager();
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
    // Implementation details copied from initialrodit.js
    // ...
  }
}

// Create or use existing instances
const stateManager = new AuthStateManager();
const roditManager = new RoditManager();
const sessionManager = session;

// Create new service instances
const blockchainService = new BlockchainService({
  CONSTANTS,
  NEAR_RPC_URL
});

const tokenService = new TokenService(stateManager, blockchainService);
const authentication = new Authentication(stateManager, tokenService, blockchainService);
const authMiddleware = new AuthenticationMiddleware(tokenService, stateManager);

// Maintain backward compatibility by exporting all the original functions
// but delegating to our new class implementations
module.exports = {
  // Original state managers
  stateManager,
  roditManager,
  
  // Constants
  CONSTANTS,
  
  // Class definitions for backward compatibility
  AuthStateManager,
  RoditManager,
  
  // Authentication functions
  login_client: (req, res) => authentication.login_client(req, res),
  logout_client: (req, res) => authentication.logout_client(req, res),
  login_server: (own_rodit) => authentication.login_server(own_rodit),
  login_portal: (own_rodit, port) => authentication.login_portal(own_rodit, port),
  login_client_withnep413: (req, res, config_own_rodit) => 
    authentication.login_client_withnep413(req, res, config_own_rodit),
  
  // Token functions
  generate_jwt_token: (peer_rodit, peer_timestamp, own_rodit, own_rodit_bytes_private_key, session_status) =>
    tokenService.generate_jwt_token(peer_rodit, peer_timestamp, own_rodit, own_rodit_bytes_private_key, session_status),
  
  // Middleware
  authenticate_apicall: (req, res, next) => authMiddleware.authenticate_apicall(req, res, next),
  
  // Webhook functions
  send_webhook: (event, data, isError, req) => authentication.send_webhook(event, data, isError, req),
  authenticate_webhook: (payload, signature_hex_ofpayload, timestamp, peer_rodit_owner_id) =>
    authentication.authenticate_webhook(payload, signature_hex_ofpayload, timestamp, peer_rodit_owner_id),

  // Blockchain functions
  nearorg_rpc_state: (id, accountId) => blockchainService.nearorg_rpc_state(id, accountId),
  nearorg_rpc_tokensfromaccountid: (id, account_id) => 
    blockchainService.nearorg_rpc_tokensfromaccountid(id, account_id),
  nearorg_rpc_fetchpublickeybytes: (accountId) =>
    blockchainService.nearorg_rpc_fetchpublickeybytes(accountId),
  nearorg_rpc_tokenfromroditid: (roditid) =>
    blockchainService.nearorg_rpc_tokenfromroditid(roditid),
  nearorg_rpc_timestamp: () => blockchainService.nearorg_rpc_timestamp(),

  // Token service functions
  base64url2jwk_public_key: (base64url_public_key) => 
    tokenService.base64url2jwk_public_key(base64url_public_key),

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