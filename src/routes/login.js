const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { login_client } = require("../middleware/initialrodit"); // Import the authentication handler

// Handling login request - CHANGE TO POST
router.post("/login", (req, res, next) => {
  req.logAction = "login-attempt";
  
  // Log the request with context
  logger.infoWithContext("Login request received", {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body // For debugging, but be careful with sensitive data
  });

  // Pass to the login_client handler
  next();
}, async (req, res) => {
  // This part should be handled by login_client middleware
  // But as a fallback, we can implement it here
  try {
    const config_own_rodit = await stateManager.getConfigOwnRodit();
    return login_client(req, res, config_own_rodit);
  } catch (error) {
    logger.errorWithContext("Login failed", {
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      message: "Internal server error during login",
      error: error.message
    });
  }
});

module.exports = router;