const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");

// Middleware for logging action - enhanced with structured context
const logActionMiddleware = (req, res, next) => {
  const inputString = req.body.message;
  req.logAction = "echo-some-text";
  req.logMessage = inputString;
  
  // Create structured context for middleware
  const middlewareContext = {
    action: req.logAction,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    messageLength: inputString ? inputString.length : 0
  };
  
  logger.debugWithContext("Request processed by middleware", middlewareContext);
  next();
};

// Protected route that echoes the input
// Note: This route is now at "/" because it will be mounted at "/api/echo" in app.js
router.post("/echo", logActionMiddleware, (req, res) => {
  const inputString = req.body.message;
  
  // Create structured context for the route handler
  const routeContext = {
    action: req.logAction,
    messageReceived: !!inputString,
    endpoint: "/echo",
    method: req.method,
    ip: req.ip,
    requestId: req.headers['x-request-id'] || 'none'
  };
  
  if (!inputString || typeof inputString !== 'string') {
    logger.warnWithContext("Invalid input for echo", routeContext);
    return res.status(400).json({ error: "Invalid input" });
  }
  
  // Use context-based logging instead of string interpolation
  logger.infoWithContext("Processing echo request", routeContext);
  
  // Create the response
  const response = { echo: inputString.toUpperCase() };
  
  // Log the response being sent
  logger.infoWithContext("Echo request completed successfully", {
    ...routeContext,
    status: "success",
    responseType: "json"
  });
  
  res.json(response);
});

module.exports = router;