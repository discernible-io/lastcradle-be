const express = require("express");
const router = express.Router();
const logger = require("../config/logger");

// Protected route that echoes the input
router.post(
  "/echo",
  (req, res, next) => {
    const inputString = req.body.message;
    req.logAction = "echo-some-text";
    req.logMessage = inputString; // Store the message for logging
    next();
  },
  (req, res) => {
    const inputString = req.body.message;
    if (!inputString) {
      return res.status(400).json({ error: "Error 110: No message provided" });
    }
    
    // Log both the action and the message
    logger.info(`Action: ${req.logAction}, Message: ${req.logMessage}`);
    
    res.json({ echo: inputString.toUpperCase() });
  }
);

module.exports = router;