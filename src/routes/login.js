// Importing the module
const express = require("express");
// Creating express Router
const router = express.Router();
const logger = require("../../config/logger");

// Handling login request
router.get("/login", (req, res, next) => {
  // Create structured context instead of string interpolation
  const context = {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    query: req.query
  };
  
  // Use warnWithContext for better Grafana searchability
  logger.warnWithContext("Login request received", context);
  
  res.send("This is the login request");
});

module.exports = router;