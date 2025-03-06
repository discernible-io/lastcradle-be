// Copyright (c) 2024 Cableguard, Inc. All rights reserved.

const config = require("config");
const express = require("express");
const cors = require("cors");
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
      // license: {
      //  name: 'Licensed Under MIT',
      //  url: 'https://spdx.org/licenses/MIT.html',
      //},
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

// Configuration is now loaded from config files
const VAULT_RODIT_KEYVALUE_PATH = config.get("VAULT_RODIT_KEYVALUE_PATH");

const swaggerSpec = swaggerJsdoc(options);
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
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
app.post(
  "/login",
  async (req, res, next) => {
    req.logAction = "login-attempt";
    next();
  },
  login_client
);

app.use((req, res, next) => {
  if (req.logAction) {
    logger.info(`Action logged: ${req.logAction}`);
  }
  next();
});

// Import protected routes
const crudaprotectedRoute = require("./protected/cruda");
const echoprotectedRoute = require("./protected/echo");

// Mount Logging middleware
app.use(loggingmw);

// Temporarily remove for token renewal tests: Apply Logging middleware to all routes
app.use((req, res, next) => ratelimiter(req, res, next));

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticate_apicall, echoprotectedRoute);

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticate_apicall, validatepermissions, crudaprotectedRoute);

app.use((err, req, res, next) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    userIP: req.ip,
    userId: req.user ? req.user.id : "anonymous",
  });
  res.status(500).json({ error: "Error 106: Internal Server Error" });
});

// Update rate limit once obtained config
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimiter = ratelimitmw(maxrequests, maxrqwindow);
}

// Store server instance and db reference
let server;
let db;

async function startServer() {
  try {
    // Initialize vault using the manager
    await roditManager.initializeVault();
    
    // Initialize RODIT configuration
    await roditManager.initializeRoditConfig("sanctum");
    
    // Get configuration from state manager
    const config_own_rodit = await stateManager.getConfigOwnRodit();
    
    if (!config_own_rodit) {
      throw new Error("Failed to initialize RODiT configuration");
    }

    // Check and update rate limits if applicable
    if (
      config_own_rodit.own_rodit.metadata.maxrequests &&
      config_own_rodit.own_rodit.metadata.maxrqwindow
    ) {
      updateratelimit(
        config_own_rodit.own_rodit.metadata.maxrequests,
        config_own_rodit.own_rodit.metadata.maxrqwindow
      );
    } else {
      logger.info("Info: Unable to update rate limit due to missing data");
    }

    // Start the server and save the instance
    const port = config_own_rodit.port || 8080;
    server = app.listen(port, () => {
      logger.info(`Info: Server started on port ${port}`);
    });
  } catch (error) {
    // Log and handle any errors that occur during server startup
    logger.error(`Error 107: Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Try to get db reference from the CRUDA route (if loaded)
try {
  if (crudaprotectedRoute.getDb) {
    db = crudaprotectedRoute.getDb();
  }
} catch (error) {
  logger.warn(`Could not get database reference: ${error.message}`);
}

startServer();

process.on("SIGINT", async () => {
  logger.info("SIGINT signal received: shutting down...");
  
  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");
    });
  }
  
  // Check if db exists and has a close method before calling it
  if (db && typeof db.close === 'function') {
    try {
      await db.close();
      logger.info("Database connection closed");
    } catch (error) {
      logger.error(`Error closing database: ${error.message}`);
    }
  }
  
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  
  if (server) {
    server.close(() => {
      logger.info("HTTP server closed");
      
      // Check if db exists and has a close method before calling it
      if (db && typeof db.close === 'function') {
        try {
          db.close();
          logger.info("Database connection closed");
        } catch (error) {
          logger.error(`Error closing database: ${error.message}`);
        }
      }
      
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

module.exports = app;