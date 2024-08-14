// Copyright (c) 2024 Cableguard, Inc. All rights reserved.

const config = require("config");
const express = require("express");
const cors = require("cors");
const https = require("https");
const ratelimitmw = require("./middleware/ratelimit");
const validatepermissions = require("./middleware/validatepermissions");
const logger = require("./config/logger");
const loggingmw = require("./middleware/loggingmw");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const forge = require("node-forge");
const crypto = require("crypto");
const fs = require("fs");

const {
  set_rodit_config,
  get_rodit_config,
  generate_jwt_token,
  verify_jwt_token,
  verify_peerrodit_getit,
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
        url: "https://localhost:3000/home.js",
      },
    },
    servers: [
      {
        url: "https://localhost:3000",
        description: "RODiT Development server",
      },
    ],
  },
  apis: ["./app.js", "./routes/*.js"],
};

// Default rate limits
let ratelimitmwph = ratelimitmw(100, 15 * 60 * 1000);

// Configuration is now loaded from config files
const SERVERPORT = config.get("SERVERPORT");
const RODIT_CONFIGURATION_FILE_PATH = config.get(
  "RODIT_CONFIGURATION_FILE_PATH"
);

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
 *                 description: The RODiT ID verify_peerrodit_getitof the user
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
  async (req, res) => {
    const { roditid: peer_roditid, roditid_base64url_signature: peer_roditid_base64url_signature } = req.body;

    console.debug("Info: Client RODiT ID:", peer_roditid);

    if (!peer_roditid || !peer_roditid_base64url_signature) {
      return res.status(400).json({ message: "Error 100: Missing RODiT ID and Signature" });
    }

    try {
      const { peer_rodit: peer_rodit, goodrodit: isRoditValid } = await verify_peerrodit_getit(peer_roditid, peer_roditid_base64url_signature);

      if (!isRoditValid) {
        logger.error("Error 101: Login attempt failed: Invalid RODiT ID or Signature");
        return res.status(401).json({ message: "Error 102: Login attempt failed: Invalid RODiT ID or Signature" });
      }

      const config_own_rodit = await get_rodit_config();
      if (!config_own_rodit) {
        throw new Error("Error 103: Server configuration not initialized");
      }

      const token = await generate_jwt_token(
        peer_rodit,
        config_own_rodit.own_rodit,
        config_own_rodit.own_rodit_bytes_private_key,
        config_own_rodit.own_roditid_base64url_signature
      );

      logger.info(`Login attempt succeeded for token ID: ${peer_rodit.token_id}`);
      return res.json({ token });

    } catch (error) {
      logger.error(`Error 104: Login attempt failed: ${error.message}`);
      return res.status(401).json({ message: `Error 105: Login attempt failed: ${error.message}` });
    }
  }
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

// Apply rate limiting middleware to all routes
app.use(ratelimitmwph);

// Mount Logging middleware
app.use(loggingmw);

// Mount rate limiter route
app.use((req, res, next) => ratelimitmwph(req, res, next));

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", verify_jwt_token, echoprotectedRoute);

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", verify_jwt_token, validatepermissions, crudaprotectedRoute);

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
  ratelimitmwph = ratelimitmw(maxrequests, maxrqwindow);
}

// Start server
async function startServer() {
  try {
    await set_rodit_config(RODIT_CONFIGURATION_FILE_PATH);
    const config_own_rodit = await get_rodit_config();

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

    app.listen(config_own_rodit.port, () => {
      logger.info(`Info: Server started on port ${config_own_rodit.port}`);
    });
  } catch (error) {
    logger.error(`Error 107:Failed to start server: ${error}`);
    process.exit(1);
  }
}

startServer();
