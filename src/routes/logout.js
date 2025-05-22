/**
 * logout.js - API routes for user logout
 * 
 * This module provides Express routes for user logout, delegating to
 * the centralized session management in sessionroutes.js.
 * 
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { ulid } = require("ulid");

// Handling logout request
router.post("/logout", (req, res) => {
  req.logAction = "logout-attempt";
  
  // Log the request with context
  logger.infoWithContext("Logout request received", {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: req.headers['x-request-id'] || ulid()
  });

  // Forward to the session routes
  // This is just a redirect to maintain backward compatibility
  // with existing code that might be using /logout endpoint
  res.redirect(307, '/api/sessions/logout');
});

module.exports = router;
