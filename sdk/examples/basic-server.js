/**
 * Basic Express server with RODiT authentication
 * 
 * This example demonstrates how to use the RODiT authentication system
 * in an Express.js application.
 * 
 * Copyright (c) 2025 Rodit Technologies Inc. All rights reserved.
 */

const express = require('express');
const { ulid } = require('ulid');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

// In a real application, you would use the npm package
// const auth = require('rodit-auth');
// For this example, we're using the local package
const auth = require('../index');

// Swagger API documentation setup
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "RODiT Authentication API Example",
      version: "1.0.0",
      description: "Example API using RODiT authentication system",
      contact: {
        name: "Rodit Technologies Inc.",
        url: "https://example.com",
      },
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Development server",
      },
    ],
  },
  apis: ["./examples/basic-server.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Create Express app
const app = express();

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Setup Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Performance monitoring middleware (simplified version)
app.use((req, res, next) => {
  req.startTime = Date.now();
  req.requestId = req.headers['x-request-id'] || ulid();
  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Setup logger
const logger = {
  debug: (message, context) => console.log(`DEBUG: ${message}`, context),
  info: (message, context) => console.log(`INFO: ${message}`, context),
  warn: (message, context) => console.log(`WARN: ${message}`, context),
  error: (message, context) => console.log(`ERROR: ${message}`, context),
  errorWithContext: (message, context, error) => console.log(`ERROR: ${message}`, context, error),
  infoWithContext: (message, context) => console.log(`INFO: ${message}`, context),
  metric: (name, value, tags) => console.log(`METRIC: ${name}=${value}`, tags)
};

// Log server startup
logger.info("Server starting", {
  component: "AppLifecycle",
  startTime: new Date().toISOString(),
  nodeEnv: process.env.NODE_ENV || 'development',
  pid: process.pid
});

// Configure authentication
auth.configure({
  logger,
  // Note: Token expiry will be extracted from the RODiT's jwt_duration metadata
  // We don't set tokenExpiry here as it will be overridden by the RODiT value
  headerName: 'Authorization',
  tokenPrefix: 'Bearer ',
  newTokenHeader: 'New-Token',
  userProperty: 'user'
});

// In a real application, the RODiT values would be fetched from the blockchain
// This is just a comment explaining the process - no manual setting of values

// The actual flow would be:
// 1. The application starts and loads the RODiT ID from environment/config
// 2. The blockchain service fetches the RODiT from the blockchain using nearorg_rpc_tokenfromroditid
// 3. The state manager is automatically populated with the RODiT data
// 4. All token lifetimes, rate limits, etc. are extracted from the blockchain-sourced RODiT

// For this example, we'll assume the stateManager has already been initialized
// by the authentication system's startup process

// Public routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the RODiT authentication example',
    endpoints: {
      login: 'POST /api/login',
      logout: 'POST /api/logout',
      protected: 'GET /api/protected',
      entities: 'GET /api/entities/:entityId'
    }
  });
});

// Authentication routes
app.post('/api/login', auth.login);
app.post('/api/logout', auth.authenticate, auth.logout);

// Protected routes
app.get('/api/protected', auth.authenticate, (req, res) => {
  res.json({
    message: 'This is a protected route',
    user: {
      id: req.user.id,
      roditId: req.user.roditId
    }
  });
});

// Rate limiting middleware using RODiT configuration from blockchain
const rateLimit = (req, res, next) => {
  const requestId = req.headers['x-request-id'];
  const startTime = Date.now();
  
  try {
    // In a real implementation, the stateManager would already have the RODiT data from the blockchain
    // The rate limit values would be extracted from the blockchain-sourced RODiT
    
    // For demonstration purposes, we'll just log what would happen
    logger.debug('Rate limit check', {
      component: 'RateLimit',
      method: 'middleware',
      message: 'Using rate limits from blockchain-sourced RODiT',
      requestId
    });
    
    // In a real implementation, you would check a counter in Redis/database
    // against the limits defined in the RODiT metadata
    
    logger.info('Rate limit check passed', {
      component: 'RateLimit',
      method: 'middleware',
      duration: Date.now() - startTime,
      requestId
    });
    
    next();
  } catch (error) {
    logger.error('Rate limit check error', {
      component: 'RateLimit',
      method: 'middleware',
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime,
      requestId
    });
    
    res.status(429).json({
      error: 'Rate limit exceeded',
      requestId
    });
  }
};

// Protected routes with permission validation and rate limiting
app.get('/api/entities/:entityId', auth.authenticate, rateLimit, auth.validatePermissions, (req, res) => {
  const entityId = req.params.entityId;
  
  // In a real implementation, this data would come from the blockchain-sourced RODiT
  // We're just showing the structure of the response here
  
  res.json({
    message: 'Entity retrieved successfully',
    entityId,
    permissionScope: req.permissionScope,
    note: 'In a real implementation, the following values would come from the blockchain-sourced RODiT',
    user: {
      id: req.user.id,
      roditId: req.user.roditId
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  logger.error('Server error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.headers['x-request-id']
  });
  
  res.status(500).json({
    error: 'Server error',
    requestId: req.headers['x-request-id']
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RODiT authentication example server running on port ${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  / - Public welcome page');
  console.log('  POST /api/login - Login with RODiT credentials');
  console.log('  POST /api/logout - Logout (requires authentication)');
  console.log('  GET  /api/protected - Protected route (requires authentication)');
  console.log('  GET  /api/entities/:entityId - Protected route with permission validation');
  console.log('');
  console.log('To login, send a POST request to /api/login with:');
  console.log('  - roditid: Your RODiT ID');
  console.log('  - timestamp: Current timestamp (optional)');
  console.log('  - roditid_base64url_signature: Base64URL signature');
  console.log('');
  console.log('RODiT Configuration:');
  console.log('  - All configuration values are automatically extracted from the blockchain-sourced RODiT');
  console.log('  - No manual configuration is needed as values come directly from the blockchain');
});

module.exports = app;
