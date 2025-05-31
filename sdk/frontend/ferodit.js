// Copyright (c) 2024 RODiT, Inc. All rights reserved.

/**
 * Module Dependencies
 */
import * as nacl from "tweetnacl";
import { jwtDecode } from "jwt-decode";
import { encodeBase64 } from "tweetnacl-util";
import { Buffer } from "buffer";

import {
  calculateCanonicalHash,
  base64ToBase64Url,
  base64url2jwk_public_key,
  jwtVerify_fe,
  verifyRoditSignature,
  validateBufferIntegrity,
  verifyHashInputs,

  bufferUtils
} from "../utils";

// Import blockchain-related classes and functions
import {
  CONSTANTS,
  nearorg_rpc_tokenfromroditid,
} from "../lib/blockchain/blockchainservice";

import {
  verify_peerrodit_getrodit
} from "../auth/authentication";

// Global state (consider refactoring to reduce global state)
class AuthStateManager {
  constructor() {
    if (AuthStateManager.instance) {
      return AuthStateManager.instance;
    }
    AuthStateManager.instance = this;

    // Standardize property names
    this.sessionBase64urlJwkPublicKey = null;
    this.configOwnRodit = null;
    this.currentToken = null;
  }

  // Use consistent method names
  setSessionBase64urlJwkPublicKey(key) {
    this.sessionBase64urlJwkPublicKey = key;
  }

  getSessionBase64urlJwkPublicKey() {
    return this.sessionBase64urlJwkPublicKey;
  }

  setConfigOwnRodit(config) {
    this.configOwnRodit = config;
  }

  getConfigOwnRodit() {
    return this.configOwnRodit;
  }

  setCurrentToken(token) {
    this.currentToken = token;
  }

  getCurrentToken() {
    return this.currentToken;
  }
}

export const stateManager = new AuthStateManager();

// Constants and data structures are now imported from blockchainservice.js

/**
 * Utility Functions
 */
// debugWithType and setValue are now imported from utils.js

export function logBufferState(stage, data, requestId) {
  console.debug(`Buffer state at ${stage}:`, {
    requestId,
    type: typeof data,
    isBuffer: data instanceof Uint8Array,
    length: data?.length || 0,
    // Convert to hex for consistent visualization
    hexRepresentation:
      data instanceof Uint8Array ? Buffer.from(data).toString("hex") : null,
    // If it's a string, show encoding hints
    stringEncoding:
      typeof data === "string"
        ? {
            hasUnicode: /[^\u0000-\u007f]/.test(data),
            length: data.length,
            // Show first 50 chars for context
            preview: data.slice(0, 50),
          }
        : null,
  });
}

export function validateMetadata(metadata) {
  // Validate URLs
  const urls = [
    metadata.openapijson_url,
    metadata.subjectuniqueidentifier_url,
    metadata.webhook_url,
  ];
  const urlPattern = /^https:\/\/([\w\-]+(\.[\w\-]+)+)/;
  urls.forEach((url) => {
    if (url && !urlPattern.test(url)) {
      throw new Error(`Invalid URL format: ${url}`);
    }
  });

  // Validate dates
  const dates = [metadata.not_before, metadata.not_after];
  dates.forEach((date) => {
    if (date) {
      const timestamp = new Date(date).getTime();
      if (isNaN(timestamp)) {
        throw new Error(`Invalid date format: ${date}`);
      }
    }
  });

  // Validate numeric fields
  ["max_requests", "maxrq_window", "jwt_duration"].forEach((field) => {
    const value = metadata[field];
    if (value && isNaN(parseInt(value))) {
      throw new Error(`Invalid numeric value for ${field}: ${value}`);
    }
  });

  return true;
}

/**
 * Session Management Functions
 */

export class RoditAuthService {
  constructor(wallet, apiEndpoint, callbackEndpoint, accountId) {
    this.wallet = wallet;
    this.apiEndpoint = apiEndpoint;
    this.callbackEndpoint = callbackEndpoint;

    // Initialize state from localStorage if available
    const storedToken = localStorage.getItem("jwt_token");
    const storedExpiration = localStorage.getItem("tokenExpiration");

    this.jwt_token = storedToken || null;
    this.tokenExpiration = storedExpiration ? parseInt(storedExpiration) : null;
    this.refreshInterval = null;

    // If we have a stored token, set up refresh
    if (this.jwt_token && this.tokenExpiration) {
      this.setupTokenRefresh();
    }
  }

  async nearorg_wallet_tokensfromaccountid(wallet, contractId, accountId) {
    try {
      const args = {
        account_id: accountId,
        from_index: null,
        limit: null,
      };

      const tokens = await wallet.viewMethod({
        contractId: contractId,
        method: "rodit_tokens_for_owner",
        args: args,
      });

      if (!Array.isArray(tokens) || tokens.length === 0) {
        return null;
      }

      const token = tokens[0];
      if (!token || !token.token_id) {
        return null;
      }

      return {
        token_id: token.token_id,
        owner_id: token.owner_id,
        metadata: token.metadata,
      };
    } catch (error) {
      console.error("Error fetching tokens:", error);
      throw error;
    }
  }

  async login_server_withnep413(options) {
    console.debug("Debug - login_server_withnep413 options:", options);

    try {
      if (!this.wallet.accountId) {
        throw new Error("Wallet not connected");
      }

      const own_rodit = await this.nearorg_wallet_tokensfromaccountid(
        this.wallet,
        process.env.REACT_APP_SCACCOUNTID,
        this.wallet.accountId
      );

      if (!own_rodit || !own_rodit.token_id) {
        throw new Error("No RODiT found for this account");
      }

      const nonce = new Uint8Array(32);
      window.crypto.getRandomValues(nonce);

      const loginData = {
        message: own_rodit.token_id,
        nonce: Array.from(nonce),
        accountId: this.wallet.accountId,
        recipient: this.apiEndpoint,
        callbackUrl: options?.callbackUrl || `${this.callbackEndpoint}/login`, // Use provided callback URL
        ownrodit: own_rodit,
      };
      sessionStorage.setItem("loginData", JSON.stringify(loginData));

      await this.wallet.signMessageWithNEP413({
        message: own_rodit.token_id,
        recipient: this.apiEndpoint,
        nonce: Buffer.from(nonce),
        callbackUrl: options?.callbackUrl || `${this.callbackEndpoint}/login`, // Use provided callback URL here too
      });
    } catch (error) {
      console.error("RODiT authentication failed:", error);
      throw error;
    }
  }

  async handleLoginCallback(url) {
    try {
      const { signature, _, accountId } = this.handleCallbackUrl(url);
      const loginData = JSON.parse(sessionStorage.getItem("loginData"));

      if (!loginData) {
        throw new Error("Login data not found");
      }

      if (loginData.accountId !== accountId) {
        throw new Error("Account ID mismatch");
      }

      const response = await fetch(`${this.apiEndpoint}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          signature: base64ToBase64Url(signature),
          message: loginData.message,
          nonce: loginData.nonce,
          recipient: loginData.recipient,
          callbackUrl: loginData.callbackUrl,
        }),
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Login failed");
      }

      const data = await response.json();
      let jwt_token = data.token;

      try {
        const { _, peer_rodit } = await validate_jwt_token_fe(
          jwt_token,
          loginData.message,
          loginData.ownrodit
        );
        const peer_bytes_ed25519_public_key = bufferUtils.hexToUint8Array(
          peer_rodit.owner_id
        );
      } catch (validationError) {
        throw new Error(
          `Error 039: Server validation failed: ${validationError.message}`
        );
      }

      console.debug("Info: Client of API endpoint is logged in");

      // Store the JWT token
      this.storeToken(jwt_token);

      // Return both the token and API endpoint
      return {
        jwt_token,
        apiEndpoint: this.apiEndpoint, // Use the class property instead of undefined variable
      };
    } catch (error) {
      console.error("Login callback failed:", error);
      throw error;
    }
  }

  storeToken(token) {
    // Parse the JWT to get expiration
    const [, payload] = token.split(".");
    const { exp } = JSON.parse(atob(payload));

    // Store in instance and localStorage
    this.jwt_token = token;
    this.tokenExpiration = exp;

    localStorage.setItem("jwt_token", token);
    localStorage.setItem("tokenExpiration", exp.toString());
  }

  handleCallbackUrl(url) {
    try {
      const hashParams = url.split("#")[1];
      if (!hashParams) {
        throw new Error("No hash parameters found in URL");
      }

      const params = new URLSearchParams(hashParams);
      const signature = params.get("signature");
      const publicKey = params.get("publicKey");
      const accountId = params.get("accountId");

      if (!signature || !publicKey || !accountId) {
        throw new Error("Missing required parameters");
      }

      return {
        signature: decodeURIComponent(signature),
        publicKey: publicKey.replace("ed25519:", ""),
        accountId,
      };
    } catch (error) {
      console.error("Error parsing callback URL:", error);
      throw error;
    }
  }

  setupTokenRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    // Check every minute if token needs refresh
    this.refreshInterval = setInterval(async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        if (this.tokenExpiration && now > this.tokenExpiration - 300) {
          await this.refreshToken();
        }
      } catch (error) {
        console.error("Token refresh failed:", error);
      }
    }, 60000);
  }

  async refreshToken() {
    try {
      if (!this.jwt_token) {
        throw new Error("No token to refresh");
      }

      const response = await fetch(`${this.apiEndpoint}/refresh`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.jwt_token}`,
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Token refresh failed");
      }

      const { token } = await response.json();
      this.storeToken(token);

      return token;
    } catch (error) {
      console.error("Token refresh failed:", error);
      // Clear stored tokens on refresh failure
      this.cleanup();
      throw error;
    }
  }

  cleanup() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    this.jwt_token = null;
    this.tokenExpiration = null;
    localStorage.removeItem("jwt_token");
    localStorage.removeItem("tokenExpiration");
  }

  // New simplified fetch function for unauthenticated access to signclient
  async fetchSignClient(url, options) {
    try {
      const headers = {
        "Content-Type": "application/json",
        // No authentication token here
      };

      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...(options.headers || {}),
        },
      });

      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(
          `Request failed: ${response.statusText}, Details: ${JSON.stringify(
            responseData
          )}`
        );
      }

      return responseData;
    } catch (error) {
      console.error(`Error in fetch: ${error.message}`);

      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        return {
          error: "InvalidResponse",
          message: "The server returned an invalid response",
        };
      }

      return {
        error: "RequestFailed",
        message: error.message,
      };
    }
  }

  async fetchWithErrorHandling_fe(url, options = {}) {
    try {
      if (this.jwt_token) {
        options.headers = {
          ...options.headers,
          Authorization: `Bearer ${this.jwt_token}`,
        };
      }

      const response = await fetch(url, options);
      const newToken = response.headers.get("New-Token");

      if (newToken) {
        this.jwt_token = newToken;
        try {
          const config = await this.roditAuth.get_rodit_config();
          if (!config) throw new Error("Client configuration not initialized");
          await this.roditAuth.validate_jwt_token(newToken, config.own_rodit);
        } catch (error) {
          throw new Error(`Token validation failed: ${error.message}`);
        }
      }

      const responseData = await response.json();

      if (!response.ok) {
        if (
          response.status === 429 &&
          responseData.error === "RateLimitExceeded"
        ) {
          return {
            error: "RateLimitExceeded",
            message: responseData.message,
            retryAfter: parseInt(
              response.headers.get("Retry-After") || "60",
              10
            ),
            maxRequests: responseData.maxRequests,
            windowMinutes: responseData.windowMinutes,
          };
        }
        throw new Error(
          `Request failed: ${response.statusText}, Details: ${JSON.stringify(
            responseData
          )}`
        );
      }

      return responseData;
    } catch (error) {
      console.error(`Request failed: ${error.message}`);
      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        return { error: "InvalidResponse", message: "Invalid server response" };
      }
      return { error: "RequestFailed", message: error.message };
    }
  }
}

// nearorg_rpc_fetchpublickeybytes is now imported from blockchainservice.js

async function validate_jwt_token_fe(token, message, own_rodit) {
  try {
    const unverifiedpayload = jwtDecode(token);

    const sp_rodit = await nearorg_rpc_tokenfromroditid(
      unverifiedpayload.rodit_id
    );

    let serviceprovider_base64_public_key = hexToBase64Url(sp_rodit.owner_id);
    const sp_public_key = await base64url2jwk_public_key(
      serviceprovider_base64_public_key
    );

    const { payload, _ } = await jwtVerify_fe(token, sp_public_key, {
      algorithms: ["EdDSA"],
    });

    stateManager.setSessionBase64urlJwkPublicKey(
      serviceprovider_base64_public_key
    );

    let { peer_rodit, goodrodit } = await verify_peerrodit_getrodit(
      payload.rodit_id,
      payload.iat,
      payload.rodit_idsignature,
      own_rodit
    );

    if (goodrodit) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) {
        throw new Error("Error 007: Token has expired");
      }

      if (payload.nbf > now) {
        throw new Error("Error 006: Token is not yet valid");
      }

      if (payload.iss !== own_rodit?.metadata?.subjectuniqueidentifier_url) {
        throw new Error("Error 005: Invalid issuer");
      }

      if (payload.aud !== own_rodit.owner_id) {
        throw new Error("Error 004: Invalid audience");
      }

      return { payload, peer_rodit };
    }
  } catch (error) {
    console.debug(`Error in validate_jwt_token_fe: ${error.message}`);
    throw error;
  }
}

export async function verifyRoditPairBeforeMinting(
  portalMetadata,
  sanctumMetadata,
  PortalSignerPublicKey,
  SanctumSignerPublicKey
) {
  // Validate metadata format
  validateMetadata(portalMetadata);
  validateMetadata(sanctumMetadata);

  // Verify matching fields
  verifyHashInputs(portalMetadata, sanctumMetadata);

  // Create RODiT objects
  const portalRodit = {
    token_id: portalMetadata.token_id,
    metadata: portalMetadata,
  };

  const sanctumRodit = {
    token_id: sanctumMetadata.token_id,
    metadata: sanctumMetadata,
  };

  // Validate buffer integrity
  validateBufferIntegrity(
    PortalSignerPublicKey,
    CONSTANTS.RODIT_ID_PK_SZ,
    "PortalSignerPublicKey"
  );
  validateBufferIntegrity(
    SanctumSignerPublicKey,
    CONSTANTS.RODIT_ID_PK_SZ,
    "SanctumSignerPublicKey"
  );

  // Verify signatures
  const portalValid = await verifyRoditSignature(
    portalRodit,
    SanctumSignerPublicKey,
    "sanctum"
  );
  const sanctumValid = await verifyRoditSignature(
    sanctumRodit,
    PortalSignerPublicKey,
    "portal"
  );

  return portalValid && sanctumValid;
}

/**
 * Verifies a RODiT's signature before minting
 *
 * @param {Object} roditMetadata - The RODiT metadata object to verify
 * @param {Uint8Array} signerPublicKey - The public key of the signer (as Uint8Array)
 * @returns {Promise<boolean>} - True if verification passes, false otherwise
 */
export async function verifyRoditBeforeMinting(Metadata, SignerPublicKey, type) {
  console.debug(`[DEBUG] Starting ${type} RODiT signature verification:`, {
    roditId: Metadata.token_id,
    signerPubKeyLength: SignerPublicKey?.length,
  });
  validateMetadata(Metadata);
  console.debug("[DEBUG] Full metadata object structure:", {
    token_id: Metadata.token_id,
    serviceprovider_id: Metadata.serviceprovider_id,
    fields: Object.keys(Metadata).sort().join(', '),
    allowed_iso3166list_type: typeof Metadata.allowed_iso3166list,
    permissioned_routes_type: typeof Metadata.permissioned_routes
  });
// Create the hash input data to check hash calculation
const hashInput = {
  token_id: Metadata.token_id,
  openapijson_url: Metadata.openapijson_url,
  not_after: Metadata.not_after,
  not_before: Metadata.not_before,
  max_requests: String(Metadata.max_requests),
  maxrq_window: String(Metadata.maxrq_window),
  allowed_cidr: Metadata.allowed_cidr,
  allowed_iso3166list: Metadata.allowed_iso3166list,
  jwt_duration: Metadata.jwt_duration,
  permissioned_routes: Metadata.permissioned_routes,
  webhook_cidr: Metadata.webhook_cidr,
  subjectuniqueidentifier_url: Metadata.subjectuniqueidentifier_url,
  serviceprovider_id: Metadata.serviceprovider_id,
};

// Log the hash calculation inputs
console.debug("[DEBUG] Hash verification input:", {
  keys: Object.keys(hashInput).sort().join(',')
});

  const rodit = {
    token_id: Metadata.token_id,
    metadata: Metadata,
  };

  validateBufferIntegrity(
    SignerPublicKey,
    CONSTANTS.RODIT_ID_PK_SZ,
    "SignerPublicKey"
  );

  // Add right before "const Valid = await verifyRoditSignature"
const serializedInput = JSON.stringify(hashInput);
console.debug("[DEBUG] Serialized hash input:", serializedInput.substring(0, 100) + "...");

// Calculate hash for comparison
const verificationHash = calculateCanonicalHash(hashInput);
console.debug("[DEBUG] Verification hash:", {
  hash: verificationHash.substring(0, 20) + "...",
  length: verificationHash.length
});

  const Valid = await verifyRoditSignature(rodit, SignerPublicKey, "server");

  return Valid;
}

export default RoditAuthService;

export const cryptoUtils = {
  nacl,
  encodeBase64,
  Buffer
};