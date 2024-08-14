const express = require("express");
const router = express.Router();
const logger = require("../config/logger");

// Protected route that echoes the input
router.post(
  "/echo",
  (req, res, next) => {
    req.logAction = "echo-some-text";
    next();
  },
  (req, res) => {
    const inputString = req.body.message;
    if (!inputString) {
      return res.status(400).json({ error: "Error 110: No message provided" });
    }
    logger.info("List of comments ECHOED");
    res.json({ echo: inputString.toUpperCase() });
  }
);

module.exports = router;