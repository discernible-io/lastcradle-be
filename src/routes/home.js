// Importing express module
const express = require("express");
const router = express.Router();
const logger = require("../../config/logger"); // Added logger import

// Handling request using router
router.get("/home", (req, res, next) => {
  // Add structured logging with context
  const context = {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    query: req.query,
    routeName: 'home'
  };
  
  logger.infoWithContext("Homepage request received", context);
  
  res.send("This is the homepage request");
});

// Importing the router
module.exports = router;