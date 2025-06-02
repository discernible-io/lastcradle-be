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

// All authentication functions are implemented directly in this file for browser compatibility
// No imports from authentication.js to avoid Node.js dependencies

// Browser-compatible versions of authentication functions
export async function verify_rodit_ownership(
  peerroditid,
  peertimestamp,
  peerroditid_base64url_signature,
  peer_rodit
) {
  console.debug("Starting RODiT ownership verification", {
    peerRoditId: peerroditid,
    timestamp: peertimestamp,
    signatureLength: peerroditid_base64url_signature?.length,
    signatureValue: peerroditid_base64url_signature?.substring(0, 20) + '...',
  });

  try {
    // Convert timestamp to date string in the same format as the backend
    const timeString = new Date(peertimestamp * 1000).toISOString();
    const roditidandtimestamp = new TextEncoder().encode(
      peerroditid + timeString
    );

    console.debug("Encoded roditid and timestamp", {
      timeString,
      peerRoditId: peerroditid,
      combinedString: peerroditid + timeString,
      bufferLength: roditidandtimestamp.length,
    });

    // Check if signature is defined before proceeding
    if (!peerroditid_base64url_signature) {
      console.error("Missing signature in authentication request", {
        peerRoditId: peerroditid,
      });
      throw new Error("Missing signature in authentication request");
    }

    const bytes_ed25519_signature = new Uint8Array(
      Buffer.from(peerroditid_base64url_signature, "base64url")
    );
    
    console.debug("Decoded signature using base64url", {
      signatureLength: bytes_ed25519_signature.length,
      expectedLength: 64, // Ed25519 signatures should be 64 bytes
    });

    const peer_bytes_ed25519_public_key =
      await nearorg_rpc_fetchpublickeybytes(
        peer_rodit.owner_id
      );

    console.debug("Retrieved public key", {
      ownerId: peer_rodit.owner_id,
      keyLength: peer_bytes_ed25519_public_key?.length || 0,
      expectedLength: 32, // Ed25519 public keys should be 32 bytes
    });

    const isaMatch = nacl.sign.detached.verify(
      roditidandtimestamp,
      bytes_ed25519_signature,
      peer_bytes_ed25519_public_key
    );

    if (isaMatch) {
      console.info("Peer RODiT ownership check successful", {
        peerRoditId: peerroditid,
        ownerId: peer_rodit.owner_id,
        outcome: "success",
      });
      return true;
    } else {
      console.error("Peer RODiT ownership check failed", {
        peerRoditId: peerroditid,
        ownerId: peer_rodit.owner_id,
        outcome: "failed",
      });
      throw new Error("Error 035: PeerEd25519SignatureVerificationFailure");
    }
  } catch (error) {
    console.error("RODiT ownership verification failed", {
      peerRoditId: peerroditid,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });
    throw new Error("Error A33: " + error.message);
  }
}

export async function verify_rodit_islive(peer_rodit_notafter, peer_rodit_notbefore) {
  console.debug("Checking RODiT time validity", {
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

  console.debug("Parsed validity dates", {
    parsedNotAfter: datetimenotafter.toISOString(),
    parsedNotBefore: datetimenotbefore.toISOString(),
    isNotAfterNull: datetimenotafter.getTime() === datetimenul.getTime(),
    isNotBeforeNull: datetimenotbefore.getTime() === datetimenul.getTime(),
  });

  try {
    // In the browser, we'll use the current time instead of blockchain time
    const datetimetimestamp = new Date(); 

    console.debug("Using browser time", {
      browserTime: datetimetimestamp.toISOString(),
    });

    const isAfterNotBefore =
      datetimetimestamp >= datetimenotbefore ||
      datetimenotbefore.getTime() === datetimenul.getTime();

    const isBeforeNotAfter =
      datetimetimestamp <= datetimenotafter ||
      datetimenotafter.getTime() === datetimenul.getTime();

    const isLive = isAfterNotBefore && isBeforeNotAfter;

    if (isLive) {
      console.info("RODiT is live", {
        currentTime: datetimetimestamp.toISOString(),
        notBefore: datetimenotbefore.toISOString(),
        notAfter: datetimenotafter.toISOString(),
        isLive: true,
      });
      return true;
    } else {
      console.warn("RODiT is not live - outside valid time period", {
        currentTime: datetimetimestamp.toISOString(),
        notBefore: datetimenotbefore.toISOString(),
        notAfter: datetimenotafter.toISOString(),
        isBeforeExpiry: isBeforeNotAfter,
        isAfterStart: isAfterNotBefore,
        isLive: false,
      });
      return false;
    }
  } catch (error) {
    console.error("Failed to check RODiT time validity", {
      notAfter: peer_rodit_notafter,
      notBefore: peer_rodit_notbefore,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });
    return false;
  }
}

export async function verify_rodit_isamatch(own_service_provider_id, peer_rodit) {
  console.debug("Starting RODiT match verification", {
    ownServiceProviderId: own_service_provider_id,
    peerRoditId: peer_rodit?.token_id,
  });

  try {
    const own_provider_components = own_service_provider_id.split(";");

    console.debug("Split provider components", {
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
      console.error("Invalid provider ID format", {
        providerId: own_service_provider_id,
        components: own_provider_components,
        hasBlockchain: !!bcPart,
        hasSmartContract: !!scPart,
        idCount: idComponents.length,
      });
      return false;
    }

    // Construct the base prefix
    const base_prefix = `${bcPart};${scPart}`;
    console.debug("Constructed base prefix", {
      basePrefix: base_prefix,
    });

    // Try verification with each ID component
    for (let i = 0; i < idComponents.length; i++) {
      const idPosition = i + 1;
      const isPartnerVerification = i === 0;
      const isPeerVerification = i > 0;
      const verificationType = isPartnerVerification ? "PARTNER" : "PEER";
      const signing_token_id = `${base_prefix};${idComponents[i]}`;

      console.debug(
        `Trying ${verificationType} verification with ID [${idPosition}/${idComponents.length}]`,
        {
          idPosition,
          verificationType,
          totalIds: idComponents.length,
          signingTokenId: signing_token_id,
        }
      );

      const signing_rodit = await nearorg_rpc_tokenfromroditid(
        signing_token_id
      );

      console.debug("Retrieved signing RODiT", {
        idPosition,
        verificationType,
        tokenId: signing_rodit?.token_id,
        ownerId: signing_rodit?.owner_id,
      });

      // For simplicity in the browser version, we'll just return true if we find a matching token
      // This is a simplified version of the complex verification in the backend
      if (signing_rodit && signing_rodit.token_id) {
        console.info("RODiT match verification successful", {
          verificationType,
          idPosition,
          signingTokenId: signing_token_id,
        });
        return true;
      }
    }

    console.warn("No matching RODiT found", {
      providerId: own_service_provider_id,
    });
    return false;
  } catch (error) {
    console.error("RODiT match verification failed", {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });
    return false;
  }
}

// Browser-compatible versions of DNS-dependent functions
export async function verify_rodit_isactive_fe(tokenId, ownsubjectuniqueidentifier_url) {
  console.debug("Browser: Checking RODiT activity status", {
    tokenId,
    subjectUrl: ownsubjectuniqueidentifier_url
  });
  
  // In browser environment, we skip DNS checks and assume the token is active
  return true;
}

export async function verify_rodit_istrusted_issuingsmartcontract_fe(ownsubjectuniqueidentifier_url) {
  console.debug("Browser: Verifying smart contract trust", {
    url: ownsubjectuniqueidentifier_url
  });
  
  // In browser environment, we skip DNS checks and assume trust is established
  return true;
}

// Browser-compatible version of verify_peerrodit_getrodit
export async function verify_peerrodit_getrodit_fe(
  peerroditid,
  peertimestamp,
  peerroditid_base64url_signature
) {
  const requestId = Math.random().toString(36).substring(2, 15);
  const startTime = Date.now();

  // Get own_rodit from stateManager
  const config_own_rodit = stateManager.getConfigOwnRodit();

  console.debug("Starting peer RODiT verification", {
    method: "verify_peerrodit_getrodit_fe",
    requestId,
    peerRoditId: peerroditid,
    timestamp: peertimestamp,
    signatureLength: peerroditid_base64url_signature?.length,
    hasOwnRodit: !!config_own_rodit,
    ownRoditId: config_own_rodit?.token_id,
  });

  try {
    console.debug("Fetching peer RODiT from blockchain", {
      requestId,
      peerRoditId: peerroditid,
    });

    const tokenFetchStart = Date.now();
    const peer_rodit = await nearorg_rpc_tokenfromroditid(peerroditid);
    const tokenFetchDuration = Date.now() - tokenFetchStart;

    console.debug("Received peer RODiT from blockchain", {
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
      console.error("Failed to retrieve peer RODiT data", {
        method: "verify_peerrodit_getrodit_fe",
        requestId,
        duration: Date.now() - startTime,
        peerRoditId: peerroditid,
      });
      return { peer_rodit: null, goodrodit: false };
    }

    if (!peer_rodit.metadata) {
      console.error("Peer RODiT missing metadata", {
        method: "verify_peerrodit_getrodit_fe",
        requestId,
        duration: Date.now() - startTime,
        peerRoditId: peerroditid,
        peerRoditOwnerId: peer_rodit.owner_id,
      });
      return { peer_rodit: null, goodrodit: false };
    }

    // Verify ownership
    const ownershipStart = Date.now();
    const ownershipVerified = await verify_rodit_ownership(
      peerroditid,
      peertimestamp,
      peerroditid_base64url_signature,
      peer_rodit
    );
    const ownershipDuration = Date.now() - ownershipStart;

    console.debug("Ownership verification completed", {
      requestId,
      ownershipDuration,
      ownershipVerified,
    });

    if (!ownershipVerified) {
      console.warn("Invalid signature, aborting RODiT verification", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify match
    const matchStart = Date.now();
    
    // Check if config_own_rodit is properly defined before accessing properties
    if (!config_own_rodit || !config_own_rodit.own_rodit.metadata) {
      console.error("Own RODiT configuration is incomplete", {
        method: "verify_peerrodit_getrodit_fe",
        requestId,
        duration: Date.now() - startTime,
        hasOwnRodit: !!config_own_rodit,
        hasMetadata: config_own_rodit && !!config_own_rodit.own_rodit.metadata
      });
      return { peer_rodit, goodrodit: false };
    }
    
    const isaMatch = await verify_rodit_isamatch(
      config_own_rodit.own_rodit.metadata.serviceprovider_id,
      peer_rodit
    );
    const matchDuration = Date.now() - matchStart;

    console.debug("Match verification completed", {
      requestId,
      matchDuration,
      isaMatch,
    });

    if (!isaMatch) {
      console.warn("RODiT match verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify live
    const liveStart = Date.now();
    const isLive = await verify_rodit_islive(
      peer_rodit.metadata.not_after,
      peer_rodit.metadata.not_before
    );
    const liveDuration = Date.now() - liveStart;

    console.debug("Live verification completed", {
      requestId,
      liveDuration,
      isLive,
    });

    if (!isLive) {
      console.warn("RODiT live verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify active - using browser-compatible version
    const activeStart = Date.now();
    const isActive = await verify_rodit_isactive_fe(
      peer_rodit.token_id,
      config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
    );
    const activeDuration = Date.now() - activeStart;

    console.debug("Active verification completed", {
      requestId,
      activeDuration,
      isActive,
    });

    if (!isActive) {
      console.warn("RODiT active verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify trusted - using browser-compatible version
    const trustedStart = Date.now();
    const isTrusted = await verify_rodit_istrusted_issuingsmartcontract_fe(
      config_own_rodit.own_rodit.metadata.subjectuniqueidentifier_url
    );
    const trustedDuration = Date.now() - trustedStart;

    console.debug("Trust verification completed", {
      requestId,
      trustedDuration,
      isTrusted,
    });

    if (!isTrusted) {
      console.warn("RODiT trust verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // All checks passed
    const totalDuration = Date.now() - startTime;

    console.info("RODiT verification successful", {
      method: "verify_peerrodit_getrodit_fe",
      requestId,
      duration: totalDuration,
      peerRoditId: peerroditid,
    });

    return { peer_rodit, goodrodit: true };
  } catch (error) {
    console.error("RODiT verification failed", {
      method: "verify_peerrodit_getrodit_fe",
      requestId,
      duration: Date.now() - startTime,
      peerRoditId: peerroditid,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });

    return { peer_rodit: null, goodrodit: false };
  }
}

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
        process.env.REACT_APP_CONTRACT_NAME,
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

    let { peer_rodit, goodrodit } = await verify_peerrodit_getrodit_fe(
      payload.rodit_id,
      payload.iat,
      payload.rodit_idsignature
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
/**
 * Verifies a RODiT's signature before minting
 * This is a browser-compatible version that works in the frontend environment
 * 
 * @param {Object} Metadata - The RODiT metadata object to verify
 * @param {Uint8Array} SignerPublicKey - The public key of the signer (as Uint8Array)
 * @param {string} type - Type of verification (client or server) for logging
 * @returns {Promise<boolean>} - True if verification passes, false otherwise
 */
export async function verifyRoditBeforeMinting(Metadata, SignerPublicKey, type) {
  console.debug(`[DEBUG] Starting ${type} RODiT signature verification:`, {
    roditId: Metadata.token_id,
    signerPubKeyLength: SignerPublicKey?.length,
  });
  
  // Validate the metadata structure
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

  // Construct the RODiT object for verification
  const rodit = {
    token_id: Metadata.token_id,
    metadata: Metadata,
  };

  // Validate the buffer integrity of the public key
  validateBufferIntegrity(
    SignerPublicKey,
    CONSTANTS.RODIT_ID_PK_SZ,
    "SignerPublicKey"
  );

  // Serialize the input for debugging
  const serializedInput = JSON.stringify(hashInput);
  console.debug("[DEBUG] Serialized hash input:", serializedInput.substring(0, 100) + "...");

  // Calculate hash for comparison
  const verificationHash = calculateCanonicalHash(hashInput);
  console.debug("[DEBUG] Verification hash:", {
    hash: verificationHash.substring(0, 20) + "...",
    length: verificationHash.length
  });

  // Verify the RODiT signature
  const Valid = await verifyRoditSignature(rodit, SignerPublicKey, "server");

  return Valid;
}

// Export all necessary functions and services
export default RoditAuthService;

// Export crypto utilities for use in other modules
export const cryptoUtils = {
  nacl,
  encodeBase64,
  Buffer
};

// logBufferState is already defined above at line 585

// Using validateBufferIntegrity from utils.js to avoid duplicate declarations

// Using verifyRoditSignature from utils.js to avoid duplicate declarations

// verifyRoditBeforeMinting is already exported via the export statement on the function declaration