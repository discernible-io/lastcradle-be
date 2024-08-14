const express = require("express");
const router = express.Router();
const logger = require("../config/logger");
const loggingmw = require("../middleware/loggingmw");
const config = require("config");

const { set_rodit_config, get_rodit_config } = require("../middleware/rodit");

const RODIT_CONFIGURATION_FILE_PATH = config.get(
  "RODIT_CONFIGURATION_FILE_PATH"
);

let roditConfig;

// Initialization function
const initializeRouter = async () => {
  try {
    await set_rodit_config(RODIT_CONFIGURATION_FILE_PATH);
    const config = await get_rodit_config();
    logger.info("Rodit configuration initialized successfully");
    return config;
  } catch (error) {
    logger.error(`Error initializing Rodit configuration: ${error.message}`);
    throw error;
  }
};

// Define logAndSendWebhook function
const logAndSendWebhook = (event, data, isError = false) => {
  const logMethod = isError ? logger.error : logger.info;
  const logMessage = `${event}: ${JSON.stringify(data)}`;
  logMethod(logMessage);
  if (
    !roditConfig ||
    !roditConfig.own_rodit.metadata.webhookurl
  ) {
    logger.error("Webhook URL not available in Rodit configuration");
    return;
  }

  // fetch(roditConfig.own_rodit.metadata.webhookurl, {
  fetch("http://localhost:3001/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event, data, isError }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.text();
    })
    .then(() => logger.info(`Webhook sent successfully: ${event}`))
    .catch((error) =>
      logger.error(`Webhook error for event ${event}: ${error.message}`)
    );
};

// Initialize the router
initializeRouter()
  .then((config) => {
    roditConfig = config;
    logger.info("CRUDA Router initialized successfully");
  })
  .catch((error) => {
    logger.error(`Failed to initialize router: ${error.message}`);
    process.exit(1); // Exit the process if initialization fails
  });

// In-memory storage for comments
let comments = [];

// Middleware to check if the comment exists
const itemExists = (req, res, next) => {
  const id = parseInt(req.body.id);
  const comment = comments.find((comment) => comment.id === id);
  if (!comment) {
    const errorMessage = `Comment not found: ${id}`;
    logAndSendWebhook("item_not_found", { id, error: errorMessage }, true);
    return res.status(404).json({ error: errorMessage });
  }
  req.comment = comment;
  next();
};

// CREATE - Add a new comment
router.post(
  "/cruda/create",
  (req, res, next) => {
    req.logAction = "create_item";
    next();
  },
  (req, res) => {
    const { name, description } = req.body;
    if (!name || !description) {
      const errorMessage =
        "Invalid create request: missing name or description";
      logAndSendWebhook("create_item_error", { error: errorMessage }, true);
      return res.status(400).json({ error: errorMessage });
    }
    const newItem = {
      id: comments.length + 1,
      name,
      description,
    };
    comments.push(newItem);
    logAndSendWebhook("item_created", {
      id: newItem.id,
      name: newItem.name,
      description: newItem.description,
    });
    res.status(201).json(newItem);
  }
);

// READ - Read all comments
router.post(
  "/cruda/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    next();
  },
  (req, res) => {
    const itemCount = comments.length;
    logAndSendWebhook("items_listed", { count: itemCount });
    res.json(comments);
  }
);

// READ - Read a specific comment
router.post(
  "/cruda/read",
  itemExists,
  (req, res, next) => {
    req.logAction = "read_item";
    next();
  },
  (req, res) => {
    logAndSendWebhook("item_read", { id: req.comment.id, name: req.comment.name, description: req.comment.description });
    res.json(req.comment);
  }
);

// UPDATE - Update a comment
router.post(
  "/cruda/update",
  itemExists,
  (req, res, next) => {
    req.logAction = "update_item";
    next();
  },
  (req, res) => {
    const { name, description } = req.body;
    const oldComment = { ...req.comment };
    if (name) req.comment.name = name;
    if (description) req.comment.description = description;
    logAndSendWebhook("item_updated", {
      id: req.comment.id,
      oldName: oldComment.name,
      newName: req.comment.name,
      oldDescription: oldComment.description,
      newDescription: req.comment.description
    });
    res.json(req.comment);
  }
);

// DESTROY - Destroy a comment
router.post(
  "/cruda/destroy",
  itemExists,
  (req, res, next) => {
    req.logAction = "destroy_item";
    next();
  },
  (req, res) => {
    const index = comments.findIndex(
      (comment) => comment.id === req.comment.id
    );
    const deletedComment = comments.splice(index, 1)[0];
    logAndSendWebhook("item_destroyed", {
      id: deletedComment.id,
      name: deletedComment.name,
      description: deletedComment.description
    });
    res.status(200).json({
      message: "Comment successfully deleted",
      deletedComment: {
        id: deletedComment.id,
        name: deletedComment.name,
        description: deletedComment.description,
      },
    });
  }
);

module.exports = router;