const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const { authenticate_apicall } = require("../middleware/initialrodit");
const { ulid } = require("ulid");

// Enhanced echo route with proper authentication and session management
router.post("/echo", authenticate_apicall, async (req, res) => {
  const requestId = req.headers['x-request-id'] || ulid();
  const { message } = req.body;
  
  // Get user session from the request (set by authenticate_apicall)
  const user = req.user;
  
  // Create structured context for logging
  const context = {
    action: "echo-request",
    requestId,
    endpoint: "/echo",
    method: req.method,
    ip: req.ip,
    userId: user?.sub || 'anonymous',
    userRoles: user?.roles || [],
    messageLength: message?.length || 0
  };

  try {
    // Input validation
    if (!message || typeof message !== 'string') {
      logger.warnWithContext("Invalid input for echo", {
        ...context,
        error: "Message is required and must be a string"
      });
      return res.status(400).json({ 
        error: "Invalid input",
        details: "Message is required and must be a string"
      });
    }

    logger.infoWithContext("Processing echo request", context);
    
    // Create the response with additional session info
    const response = { 
      echo: message.toUpperCase(),
      timestamp: new Date().toISOString(),
      requestId,
      userId: user?.sub,
      roles: user?.roles || []
    };
    
    // Log successful processing
    logger.infoWithContext("Echo request completed successfully", {
      ...context,
      status: "success",
      responseType: "json"
    });
    
    res.json(response);
  } catch (error) {
    // Log the error with context
    logger.errorWithContext("Error processing echo request", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: "Internal server error",
      requestId,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;