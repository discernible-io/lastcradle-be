/**
 * RODiT ID Authentication System
 * 
 * This module exports only the RoditClient class which provides access to all SDK functionality.
 * All authentication, middleware, services, and utilities are accessible through RoditClient methods.
 * 
 * Copyright (c) 2025 Discernible Inc. All rights reserved.
 */

const { RoditClient } = require('./roditclient');

// Export only the RoditClient class
module.exports = {
  RoditClient
};

