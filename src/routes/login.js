const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");

// Import the unified auth module from npm package
const auth = require('@rodit/rodit-auth-be');
const { logger } = auth;
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
router.post('/login', (req, res) => {
  req.logAction = "login-attempt";
  logger.info("Login request received", {
    component: "API",
    method: "login",
    requestId: req.requestId || ulid(),
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  
  // Use the SDK's login function
  roditClient.login(req, res);
});

// Legacy login route - redirects to new endpoint
router.post("/", (req, res) => {
  req.logAction = "legacy-login-attempt";
  res.redirect(307, '/api/login');
});

module.exports = router;