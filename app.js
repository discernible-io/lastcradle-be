const express = require("express");
const cors = require("cors");
const nacl = require("tweetnacl");
nacl.util = require("tweetnacl-util");
const https = require('https');
const config = require("config");
const ratelimitmw = require("./middleware/ratelimit");
const validatepermissions = require("./middleware/validatepermissions");
const logger = require("./config/logger");
const loggingmw = require("./middleware/loggingmw");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");

const {
  verify_hasrodit_getit,
  verify_rodit_isamatch,
  verify_rodit_islive,
  verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract,
  generate_jwt_token,
  roditconfig,
  hex2base64url,
  set_session_jwk_public_key,
  authenticatetoken,
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

// Configuration is now loaded from config files
const CONFIGURATION_FILE_PATH = config.get("CONFIGURATION_FILE_PATH");
const PORT = config.get("PORT");

/*
const API_PROTOCOL = config.get("API_PROTOCOL");

const options = {
  key: fs.readFileSync('path/to/private-key.pem'),
  cert: fs.readFileSync('path/to/certificate.pem')
};
const server = https.createServer(options, app);
*/

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
 *                 description: The RODiT ID of the user
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
    // Log the action
    req.logAction = "login-attempt";
    next();
  },
  async (req, res) => {
    const { roditid, roditid_base64url_signature } = req.body;

    let peer_roditid = roditid;
    let peer_roditid_base64url_signature = roditid_base64url_signature;
    console.debug("Info: Client RODiT ID:", peer_roditid);

    if (!peer_roditid || !peer_roditid_base64url_signature) {
      return res
        .status(400)
        .json({ message: "Error: Missing RODiT ID and Signature" });
    }

    try {

      let {
        own_rodit,
        own_roditid_base64url_signature,
        own_rodit_bytes_private_key,
        own_rodit_hex_accountid,
      } = await roditconfig(CONFIGURATION_FILE_PATH);

      if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
        updateratelimit(
          own_rodit.metadata.maxrequests,
          own_rodit.metadata.maxrqwindow
        );
      } else {
        console.debug(
          "Info: Unable to update rate limit due to missing data"
        );
      }
      
      const session_base64url_jwk_public_key = hex2base64url(
        own_rodit_hex_accountid
      );
      set_session_jwk_public_key(session_base64url_jwk_public_key);

      const peer_rodit = await verify_hasrodit_getit(
        peer_roditid,
        peer_roditid_base64url_signature
      );

      const [isVerified, isLive, isActive, isTrusted] = await Promise.all([
        verify_rodit_isamatch(
          own_rodit.metadata.serviceproviderid,
          peer_rodit.metadata.serviceprovidersignature,
          peer_rodit.token_id
        ),
        verify_rodit_islive(
          peer_rodit.metadata.notafter,
          peer_rodit.metadata.notbefore
        ),
        verify_rodit_isactive(
          peer_rodit.token_id,
          own_rodit.metadata.subjectuniqueidentifierurl
        ),
        verify_rodit_istrusted_issuingsmartcontract(
          own_rodit.metadata.subjectuniqueidentifierurl
        ),
      ]);

      if (!isVerified || !isLive || !isActive || !isTrusted) {
        throw new Error("Error: RODiT verification failed");
      }

      const token = await generate_jwt_token(
        peer_rodit,
        own_rodit,
        own_rodit_bytes_private_key,
        own_roditid_base64url_signature
      );

      logger.warn(`Info: Login attempt succeeded:`, peer_rodit.token_id);
      res.json({ token });
    } catch (error) {
      logger.error(`Error 001: Login attempt failed: ${error}`);
      res
        .status(401)
        .json({ message: "Error 001: Login attempt failed:", error: error.message });
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
const echoprotectedRoute = require("./protected/echo");
const crudarotectedRoute = require("./protected/cruda");

// Mount Logging middleware
app.use(loggingmw);

// Mount rate limiter route
app.use((req, res, next) => ratelimitmwph(req, res, next));

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticatetoken, validatepermissions, crudarotectedRoute);

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use("/api", authenticatetoken, validatepermissions, echoprotectedRoute);

app.use((err, req, res, next) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    userIP: req.ip,
    userId: req.user ? req.user.id : "anonymous",
  });
  res.status(500).json({ error: "Error: Internal Server Error" });
});

// Update rate limit once obtained config from RODiT
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimitmwph = ratelimitmw(maxrequests, maxrqwindow);
}

// Start server
app.listen(PORT, () => {
  logger.info(`Info: Server started on port ${PORT}`);
});