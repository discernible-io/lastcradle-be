/**
 * logout.js - Express router for logout functionality
 * 
 * This module provides Express routes for handling user logout requests.
 * 
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { logout_client } = require("../middleware/session"); // Import the logout handler

/**
 * POST /logout - Handle user logout
 * 
 * Expected request:
 * Headers:
 *   - Authorization: Bearer [token]
 * 
 * Optional body:
 *   - reason: reason for logout (e.g., 'user_initiated', 'session_timeout')
 * 
 * Response:
 *   - 200: Logout successful
 *   - 401: No authentication token provided
 *   - 500: Server error
 */
router.post("/logout", (req, res, next) => {
  req.logAction = "logout-attempt";
  
  // Log the request with context
  logger.infoWithContext("Logout request received", {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body // For debugging, but be careful with sensitive data
  });
  
  // Pass to the logout_client handler
  next();
}, async (req, res) => {
  // This part should be handled by logout_client middleware
  // But as a fallback, we can implement it here
  try {
    return await logout_client(req, res);
  } catch (error) {
    logger.errorWithContext("Logout failed", {
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      message: "Internal server error during logout",
      error: error.message
    });
  }
});

module.exports = router;