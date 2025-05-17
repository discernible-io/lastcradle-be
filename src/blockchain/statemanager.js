/**
 * Authentication State Manager for RODiT operations
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const { ulid } = require("ulid");
const logger = require("../../config/logger");

/**
 * Singleton class for managing authentication state
 * This includes RODiT configurations, JWT tokens, and public keys
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
    this.signportalJwtToken = null;
    this.jwtToken = null;
    
    // Session management
    this.sessions = new Map();

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

  // RODiT configuration management
  async setConfigOwnRodit(config) {
    this.configOwnRodit = config;
    return config;
  }

  getConfigOwnRodit() {
    return this.configOwnRodit;
  }

  // JWT token management
  async setSignPortalJwtToken(token) {
    this.signportalJwtToken = token;
    return token;
  }

  getSignPortalJwtToken() {
    return this.signportalJwtToken;
  }

  async setJwtToken(token) {
    this.jwtToken = token;
    return token;
  }

  getJwtToken() {
    return this.jwtToken;
  }

  // Session management
  createSession(sessionData) {
    if (!sessionData || !sessionData.id) {
      throw new Error("Session data must include an ID");
    }
    
    this.sessions.set(sessionData.id, {
      ...sessionData,
      lastAccessedAt: Math.floor(Date.now() / 1000)
    });
    
    return this.sessions.get(sessionData.id);
  }
  
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
  
  updateSession(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    this.sessions.set(sessionId, {
      ...session,
      ...updates
    });
    
    return this.sessions.get(sessionId);
  }
  
  isSessionActive(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    
    return session.status === "active";
  }
  
  // Portal URL helper
  getPortalUrl(serviceProviderId, port = 443) {
    if (!serviceProviderId) {
      throw new Error("Service provider ID is required");
    }
    
    // Format: https://{serviceProviderId}.aparejos.net:{port}
    return `https://${serviceProviderId}.aparejos.net:${port}`;
  }
}

// Create a singleton instance
const stateManager = new AuthStateManager();

// Export the singleton
module.exports = {
  stateManager
};
