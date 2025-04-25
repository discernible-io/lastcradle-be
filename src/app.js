// Copyright (c) 2024 Cableguard, Inc. All rights reserved.

const config = require("config");
const express = require("express");
const https = require("https");
const ratelimitmw = require("./middleware/ratelimit");
const validatepermissions = require("./middleware/validatepermissions");
const logger = require("../config/logger");
const loggingmw = require("./middleware/loggingmw");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const forge = require("node-forge");
const {
  set_rodit_config,
  get_rodit_config,
  login_client,
  authenticate_apicall,
} = require("./middleware/rodit");
const {
  roditManager,
  stateManager,
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

// Routes

// Log in route
/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate user
 *     description: Authenticate a user using their RODiT ID and signature
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               peer_roditid:
 *                 type: string
 *                 description: The RODiT ID verify_peerrodit_getroditof the user
 *               peer_roditid_base64url_signature:
 *                 type: string
 *                 description: The base64url signature of the RODiT ID
 *     responses:
 *       200:
 *         description: Successful authentication
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT token for authenticated session
 *       400:
 *         description: Missing RODiT ID or Signature
 *       401:
 *         description: Authentication failed
 */
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
const crudaprotectedRoute = require("./protected/cruda");
const echoprotectedRoute = require("./protected/echo");
const signclientprotectedRoute = require("./protected/signclient");

// Mount Logging middleware
app.use(loggingmw);

// Mount signclient protected route, where token is authenticated and permissions vetted
app.use("/api", signclientprotectedRoute);

// Temporarily remove for token renewal tests: Apply Logging middleware to all routes
// app.use((req, res, next) => ratelimiter(req, res, next));

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticate_apicall, validatepermissions, echoprotectedRoute);

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticate_apicall, validatepermissions, crudaprotectedRoute);

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
  
  res.status(500).json({ error: "Error 106: Internal Server Error" });
});

// Update rate limit once obtained config
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimiter = ratelimitmw(maxrequests, maxrqwindow);
  logger.infoWithContext("Rate limit settings updated", { 
    maxRequests: maxrequests, 
    windowDuration: maxrqwindow 
  });
}

// Store server instance and db reference
let server;
let db;

async function startServer() {
  try {
    // Initialize vault and configuration
    await roditManager.initializeVault();
    await roditManager.initializeRoditConfig("server");

    logger.infoWithContext("Server initialization successful", {
      component: "vault",
      status: "initialized"
    });

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

startServer();

// Handle SIGINT gracefully
process.on("SIGINT", async () => {
  logger.infoWithContext("Shutdown initiated", { signal: "SIGINT" });
  
  if (server) {
    server.close(() => {
      logger.infoWithContext("HTTP server closed", { component: "http-server" });
    });
  }
  
  // Check if db exists and has a close method before calling it
  if (db && typeof db.close === 'function') {
    try {
      await db.close();
      logger.infoWithContext("Database connection closed", { component: "main-db" });
    } catch (error) {
      logger.errorWithContext(
        "Error closing database", 
        { component: "main-db" },
        error
      );
    }
  }
  
  // Close the CRUDA database connection
  try {
    if (crudaprotectedRoute.closeDatabase) {
      await crudaprotectedRoute.closeDatabase();
      logger.infoWithContext("CRUDA database connection closed", { component: "cruda-db" });
    }
  } catch (error) {
    logger.errorWithContext(
      "Error closing CRUDA database", 
      { component: "cruda-db" },
      error
    );
  }
  
  process.exit(0);
});

// Handle SIGTERM gracefully
process.on("SIGTERM", async () => {
  logger.infoWithContext("Shutdown initiated", { signal: "SIGTERM" });
  
  if (server) {
    server.close(async () => {
      logger.infoWithContext("HTTP server closed", { component: "http-server" });
      
      // Check if db exists and has a close method before calling it
      if (db && typeof db.close === 'function') {
        try {
          await db.close();
          logger.infoWithContext("Database connection closed", { component: "main-db" });
        } catch (error) {
          logger.errorWithContext(
            "Error closing database", 
            { component: "main-db" },
            error
          );
        }
      }
      
      // Close the CRUDA database connection
      try {
        if (crudaprotectedRoute.closeDatabase) {
          await crudaprotectedRoute.closeDatabase();
          logger.infoWithContext("CRUDA database connection closed", { component: "cruda-db" });
        }
      } catch (error) {
        logger.errorWithContext(
          "Error closing CRUDA database", 
          { component: "cruda-db" },
          error
        );
      }
      
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

module.exports = app;