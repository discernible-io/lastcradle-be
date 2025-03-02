// Importing the module
const express = require("express");

// Creating express Router
const router = express.Router();

const logger = require("../config/logger");

// Handling login request
router.get("/login", (req, res, next) => {
  logger.warn(`Login request recorded: ${req}`);
  res.send("This is the login request");
});
module.exports = router;
