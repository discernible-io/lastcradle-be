const express = require("express")
const ratelimitmw = require("./middleware/ratelimit");
const validatepermissions = require("./middleware/validatepermissions");
const logger = require("../config/logger");
const loggingmw = require("./middleware/loggingmw");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const {
  login_client,
  authenticate_apicall,
  initializeServices,
  stateManager,
  roditManager
} = require("./middleware/rodit");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "RODiT prototype API",
      version: "1.0.0",
      description:
        "This is a REST API application made with Express. It just echoes whatever string you send to it.",
      contact: {
        name: "JSONPlaceholder for the contact name",
        url: "https:// https://dev-api.aparejos.net:3443/home.js",
      },
    },
    servers: [
      {
        url: "https:// https://dev-api.aparejos.net:3443",
        description: "RODiT Development server",
      },
    ],
  },
  apis: ["./app.js", "./routes/*.js"],
};

// Default rate limits
let ratelimiter = ratelimitmw(100, 15);

const swaggerSpec = swaggerJsdoc(options);
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Apply rate limiting to all routes
// app.use((req, res, next) => ratelimiter(req, res, next));

// Log in route - non-protected
app.post("/login", (req, res, next) => {
  req.logAction = "login-attempt";
  next();
}, async (req, res) => {
  const config_own_rodit = await stateManager.getConfigOwnRodit();
  return login_client(req, res, config_own_rodit);
});

app.use((req, res, next) => {
  if (req.logAction) {
    logger.infoWithContext(`Action executed`, {
      action: req.logAction,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous"
    });
  }
  next();
});

// Import protected routes
const echoprotectedRoute = require("./protected/echo");
const crudaprotectedRoute = require("./protected/cruda");
const signclientRoute = require("./routes/signclient");

// Mount Logging middleware
app.use(loggingmw);

app.use("/api/echo", authenticate_apicall, echoprotectedRoute);
app.use("/api/cruda", authenticate_apicall, validatepermissions, crudaprotectedRoute);
app.use("/api", signclientRoute);

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  logger.errorWithContext(
    "Server error occurred",
    {
      method: req.method,
      url: req.originalUrl,
      userIP: req.ip,
      userId: req.user ? req.user.id : "anonymous",
      errorCode: "106",
      route: req.route ? req.route.path : "unknown"
    },
    err // Pass the error object directly
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
});

// Update rate limit once obtained config
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimiter = ratelimitmw(maxrequests, maxrqwindow);
}

// Store server instance and db reference
let server;

async function startServer() {
  try {
    logger.info("Starting server initialization...");
    
    // Initialize all services
    await initializeServices();
    
    logger.info("Services initialized, starting HTTP server...");

    // Get and apply configuration
    const configObject = await stateManager.getConfigOwnRodit();
    if (!configObject) {
      throw new Error("Failed to initialize RODiT configuration");
    }

    // Update rate limits if applicable
    const own_rodit = configObject.own_rodit;
    if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
      updateratelimit(
        own_rodit.metadata.maxrequests,
        own_rodit.metadata.maxrqwindow
      );
    }

    // Start the HTTP server
    const port = configObject.port || 8080;
    server = app.listen(port, () => {
      logger.infoWithContext("Server started", {
        port: port,
        env: process.env.NODE_ENV || "development",
        protocol: "http"
      });
    });

    // Graceful shutdown handling
    process.on("SIGTERM", () => {
      logger.info("SIGTERM signal received: closing HTTP server");
      server.close(() => {
        logger.info("HTTP server closed");
        process.exit(0);
      });
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', { promise, reason });
      // Consider whether to exit the process here
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      // Consider whether to exit the process here
    });
    
  } catch (error) {
    logger.errorWithContext(
      "Failed to start server", 
      {
        errorCode: "907",
        component: "server-startup"
      },
      error
    );
    process.exit(1);
  }
}

// Start the server
startServer();

// Handle SIGINT gracefully
process.on("SIGINT", async () => {
  logger.info("SIGINT received. Shutting down gracefully...");
  
  try {
    // Close the server
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    
    // Perform any additional cleanup here
    logger.info("Server shut down successfully");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown:", error);
    process.exit(1);
  }
});

// Export app for testing
module.exports = app;