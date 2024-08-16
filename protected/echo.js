const express = require("express");
const router = express.Router();
const logger = require("../config/logger");

// Middleware for logging action
const logActionMiddleware = (req, res, next) => {
  const inputString = req.body.message;
  req.logAction = "echo-some-text";
  req.logMessage = inputString;
  next();
};

// Protected route that echoes the input
router.post("/echo", logActionMiddleware, (req, res) => {
  const inputString = req.body.message;
  logger.info(`Action: ${req.logAction}, Message: ${req.logMessage}`);
  const response = { echo: inputString.toUpperCase() };
  if (req.new_jwt_token) {
    response.new_jwt_token = req.new_jwt_token;
  }
  res.json(response);
});

module.exports = router;
