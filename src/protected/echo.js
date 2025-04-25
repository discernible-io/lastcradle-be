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
router.post("/echo", logActionMiddleware, (req, res) => {
  const inputString = req.body.message;
  
  if (!inputString || typeof inputString !== 'string') {
    logger.warnWithContext("Invalid input for echo", routeContext);
    return res.status(400).json({ error: "Invalid input" });
  }

  // Create structured context for the route handler
  const routeContext = {
    action: req.logAction,
    messageReceived: true,
    hasJwtToken: !!req.new_jwt_token,
    endpoint: "/echo",
    method: req.method,
    ip: req.ip,
    requestId: req.headers['x-request-id'] || 'none'
  };
  
  // Use context-based logging instead of string interpolation
  logger.infoWithContext("Processing echo request", routeContext);
  
  // Create response and log success
  const response = { echo: inputString.toUpperCase() };
  
  if (req.new_jwt_token) {
    response.new_jwt_token = req.new_jwt_token;
    logger.debugWithContext("Adding new JWT token to response", {
      ...routeContext,
      tokenAdded: true
    });
  }
  
  // Log the response being sent
  logger.infoWithContext("Echo request completed successfully", {
    ...routeContext,
    status: "success",
    responseType: "json"
  });
  
  res.json(response);
});

module.exports = router;