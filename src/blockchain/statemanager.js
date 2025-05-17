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
    if (!this.sessions.has(sessionId)) {
      return null;
    }
    
    const session = this.sessions.get(sessionId);
    const updatedSession = {
      ...session,
      ...updates,
      lastAccessedAt: Math.floor(Date.now() / 1000)
    };
    
    this.sessions.set(sessionId, updatedSession);
    return updatedSession;
  }
  
  deleteSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      return false;
    }
    
    return this.sessions.delete(sessionId);
  }
  
  getAllSessions() {
    return Array.from(this.sessions.values());
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
};

// Create and export a singleton instance
const stateManager = new AuthStateManager();
module.exports = stateManager;
