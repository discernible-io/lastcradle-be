const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { authenticate_apicall } = require("../middleware/rodit");

// Protected route that echoes the input
// Using the new authentication middleware
router.post("/echo", authenticate_apicall, (req, res) => {
  const inputString = req.body.message;
  
  // Create structured context for the route handler
  const routeContext = {
    action: "echo-request",
    messageReceived: !!inputString,
    endpoint: "/echo",
    method: req.method,
    ip: req.ip,
    requestId: req.headers['x-request-id'] || 'none',
    userId: req.user?.sub || 'anonymous'
  };
  
  if (!inputString || typeof inputString !== 'string') {
    logger.warnWithContext("Invalid input for echo", routeContext);
    return res.status(400).json({ error: "Invalid input" });
  }
  
  logger.infoWithContext("Processing echo request", routeContext);
  
  // Create the response
  const response = { 
    echo: inputString.toUpperCase(),
    timestamp: new Date().toISOString()
  };
  
  // The new authentication middleware automatically handles token management
  // No need to manually check/set JWT tokens here
  
  logger.infoWithContext("Echo request completed successfully", {
    ...routeContext,
    status: "success",
    responseType: "json"
  });
  
  res.json(response);
});

module.exports = router;