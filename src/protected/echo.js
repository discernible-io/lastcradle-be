const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { RoditClient } = require("@rodit/rodit-auth-be");

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();
const { createLogContext, logErrorWithMetrics } = logger;

// Middleware for logging action - enhanced with structured context
const logActionMiddleware = (req, res, next) => {
  const requestId = req.headers['x-request-id'] || ulid();
  const startTime = Date.now();
  const inputString = req.body.message || req.body.echo || req.body.data || req.body.text;
  
  req.logAction = "echo-some-text";
  req.logMessage = inputString;
  req.requestId = requestId; // Set requestId for downstream handlers
  req.startTime = startTime; // Track when the request started
  
  const baseContext = createLogContext({
    requestId,
    component: 'EchoMiddleware',
    method: 'logActionMiddleware',
    endpoint: req.path,
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    headers: Object.keys(req.headers),
    messageLength: inputString ? inputString.length : 0,
    bodyKeys: Object.keys(req.body || {}),
    bodySize: req.body ? JSON.stringify(req.body).length : 0
  });
  
  logger.debugWithContext("Request processed by middleware", baseContext);
  
  const middlewareDuration = Date.now() - startTime;
  logger.metric('middleware_operations', middlewareDuration, {
    operation: 'echoMiddleware',
    result: 'processed'
  });
  
  next();
};

// Protected route that echoes the input
// This route is at "/" because it's mounted at "/api/echo" in app.js
router.post("/", logActionMiddleware, (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = req.startTime || Date.now(); // Use middleware time if available
  const routeStartTime = Date.now(); // Track when route handler started
  
  // Extract input from various possible fields for test compatibility
  const inputString = req.body.message || req.body.echo || req.body.data || req.body.text;
  
  const baseContext = createLogContext({
    requestId,
    component: 'EchoRoutes',
    method: 'echoMessage',
    endpoint: '/api/echo',
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    messageReceived: !!inputString,
    messageLength: inputString ? inputString.length : 0
  });
  
  try {
    // Validate content type first
    const contentType = req.get('Content-Type') || '';
    const isJsonContentType = contentType.includes('application/json');
    
    if (!isJsonContentType) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.warnWithContext("Invalid content type for echo", {
        ...baseContext,
        validationError: 'Unsupported content type',
        contentType,
        duration,
        routeDuration
      });
      
      // Add metric for content type validation failure
      logger.metric('echo_operations', duration, {
        operation: 'echoMessage',
        result: 'content_type_error',
        statusCode: 400
      });
      
      return res.status(400).json({
        error: "Invalid input",
        requestId
      });
    }
    
    // Validate input - allow empty strings but require string type
    if (inputString === undefined || inputString === null || typeof inputString !== 'string') {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.warnWithContext("Invalid input for echo", {
        ...baseContext,
        validationError: 'Invalid or missing message - must be a string',
        inputType: typeof inputString,
        inputValue: inputString,
        duration,
        routeDuration
      });
      
      // Add metric for validation failure
      logger.metric('echo_operations', duration, {
        operation: 'echoMessage',
        result: 'validation_error',
        statusCode: 400
      });
      
      return res.status(400).json({
        error: "Invalid input",
        requestId
      });
    }
    
    logger.debugWithContext("Processing echo request", baseContext);
    
    const duration = Date.now() - startTime;
    const routeDuration = Date.now() - routeStartTime;
    
    logger.infoWithContext("Echo request completed successfully", {
      ...baseContext,
      status: "success",
      responseType: "json",
      duration,
      routeDuration
    });
    
    // Add metric for successful operation
    logger.metric('echo_operations', duration, {
      operation: 'echoMessage',
      result: 'success',
      messageLength: inputString.length
    });
    
    // Create the response in the format expected by client tests
    // Client expects: response.data.message, response.data.input, or response.data.echo
    res.json({
      data: {
        message: inputString,
        input: inputString,
        echo: inputString
      },
      requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const routeDuration = Date.now() - routeStartTime;
    
    logErrorWithMetrics(
      'Error processing echo request',
      {
        ...baseContext,
        duration,
        routeDuration
      },
      error,
      'echo_error',
      {
        operation: 'echoMessage',
        result: 'error',
        duration
      }
    );
    
    res.status(500).json({
      error: 'Failed to process echo request',
      message: 'An internal server error occurred',
      requestId
    });
  }
});

// GET route for basic echo endpoint info
router.get("/", (req, res) => {
  const requestId = req.headers['x-request-id'] || ulid();
  
  logger.info("Echo endpoint info requested", {
    component: 'EchoRoutes',
    method: 'getInfo',
    requestId,
    ip: req.ip
  });
  
  res.json({
    message: "Echo endpoint - POST JSON data to echo it back",
    usage: "POST /api/echo with JSON body containing message, echo, data, or text field",
    requestId
  });
});

module.exports = router;