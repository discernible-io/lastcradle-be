const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { login_client } = require("../middleware/authenticationmw");

// Handling login request
router.post("/login", (req, res) => {
  req.logAction = "login-attempt";
  
  // Log the request with context
  logger.infoWithContext("Login request received", {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.body // For debugging, but be careful with sensitive data
  });

  // Pass to the login_client handler directly
  login_client(req, res);
});

module.exports = router;