const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");

// Import the unified auth module from npm package
const { RoditClient } = require('@rodit/rodit-auth-be');

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();
const { createLogContext, logErrorWithMetrics } = logger;

/**
 * @swagger
 * /api/login:
 *   post:
 *     summary: User login
 *     description: Authenticate using RODiT credentials
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roditid
 *               - roditid_base64url_signature
 *             properties:
 *               roditid:
 *                 type: string
 *                 description: RODiT ID
 *               timestamp:
 *                 type: integer
 *                 description: Current timestamp (optional)
 *               roditid_base64url_signature:
 *                 type: string
 *                 description: Base64URL signature
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Authentication failed
 */
router.post('/', async (req, res) => {
  req.logAction = "login-attempt";
  logger.info("Login request received", {
    component: "API",
    method: "login",
    requestId: req.requestId || ulid(),
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // Use the RoditClient stored in app.locals
  const client = req.app.locals.roditClient;
  if (!client) {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }
  
  // Use the login method that handles Express req/res (maps to login_client)
  await client.login(req, res);
});

module.exports = router;