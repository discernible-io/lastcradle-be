const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const config = require("config");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const {
  roditManager,
  stateManager,
  send_webhook,
} = require("../middleware/rodit");

const VAULT_RODIT_KEYVALUE_PATH = config.get("VAULT_RODIT_KEYVALUE_PATH");

const LOG_DIR = config.get("API_OPTIONS.LOG_DIR");
const DB_PATH = config.get("API_OPTIONS.DB_PATH");

let db;
const initializeRouter = async () => {
  try {
    // Initialize the vault
    await roditManager.initializeVault();
    
    // Initialize RODIT configuration using the same method as the working API
    logger.info("Initializing RODIT configuration using RoditManager");
    await roditManager.initializeRoditConfig("server");
    
    // Get the configuration from the stateManager
    const config = await stateManager.getConfigOwnRodit();
    
    if (!config) {
      throw new Error("Failed to initialize RODiT configuration");
    }
    
    logger.info(`Successfully initialized RODiT configuration with account_id: ${config.own_rodit.owner_id.substring(0, 8)}...`);

    // Initialize SQLite database
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    // Create comments table if it doesn't exist
    await db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT
    )`);

    logger.info("SQLite database initialized successfully");

    return config;
  } catch (error) {
    logger.error(
      `Error initializing Rodit configuration or SQLite database: ${error.message}`
    );
    throw error;
  }
};

const logEvent = (event, data, isError = false) => {
  const logMethod = isError ? logger.error : logger.info;
  const logMessage = `${event}: ${JSON.stringify(data)}`;
  logMethod(logMessage);
};

// Combined function that logs and sends webhook
const logAndSendWebhook = async (event, data, isError = false) => {
  const result = await send_webhook(event, data, isError);

  if (result.isValid) {
    logger.info(
      `Webhook sent successfully - Event: ${event}, Request ID: ${result.requestId}`
    );
  } else {
    logger.error(
      `Webhook send failed - Event: ${event}, Error: ${result.error.message}, Request ID: ${result.requestId}`
    );
  }

  // You can still log the event locally if needed
  logEvent(event, data, isError, result.requestId);
};

// Initialize the router
initializeRouter()
  .then((config) => {
    logger.info("CRUDA Router initialized successfully");
  })
  .catch((error) => {
    logger.error(`Failed to initialize router: ${error.message}`);
    process.exit(1);
  });

// Middleware to check if the comment exists
const itemExists = async (req, res, next) => {
  const id = parseInt(req.body.id);
  try {
    const comment = await db.get("SELECT * FROM comments WHERE id = ?", id);
    if (!comment) {
      const errorMessage = `Comment not found: ${id}`;
      logAndSendWebhook("comment_not_found", { id, error: errorMessage }, true);
      return res.status(404).json({ error: errorMessage });
    }
    req.comment = comment;
    next();
  } catch (error) {
    logger.error(`Error checking if item exists: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
};

// CREATE - Add a new comment
router.post(
  "/cruda/create",
  (req, res, next) => {
    req.logAction = "create_item";
    next();
  },
  async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) {
      const errorMessage = "Invalid create request: missing title or content";
      logAndSendWebhook("create_comment_error", { error: errorMessage }, true);
      return res.status(400).json({ error: errorMessage });
    }
    try {
      const result = await db.run(
        "INSERT INTO comments (title, content) VALUES (?, ?)",
        [title, content]
      );
      const newItem = {
        id: result.lastID,
        title,
        content,
      };
      logAndSendWebhook("comment_created", newItem);
      const response = { ...newItem };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
      }
      res.status(201).json(response);
    } catch (error) {
      logger.error(`Error creating comment: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// READ - Read all comments
router.post(
  "/cruda/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    next();
  },
  async (req, res) => {
    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;
      logAndSendWebhook("comments_listed", { count: itemCount });
      const response = { comments };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
      }
      res.json(response);
    } catch (error) {
      logger.error(`Error listing comments: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
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
    logAndSendWebhook("comment_read", req.comment);
    const response = { ...req.comment };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
    }
    res.json(response);
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
  async (req, res) => {
    const { id, title, content } = req.body;
    const oldComment = { ...req.comment };
    try {
      await db.run(
        "UPDATE comments SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?",
        [title, content, id]
      );
      const updatedComment = await db.get(
        "SELECT * FROM comments WHERE id = ?",
        id
      );
      logAndSendWebhook("comment_updated", {
        id: updatedComment.id,
        oldTitle: oldComment.title,
        newTitle: updatedComment.title,
        oldContent: oldComment.content,
        newContent: updatedComment.content,
      });
      const response = { ...updatedComment };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
      }
      res.json(response);
    } catch (error) {
      logger.error(`Error updating comment: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
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
  async (req, res) => {
    const { id } = req.body;
    try {
      const deletedComment = { ...req.comment };
      await db.run("DELETE FROM comments WHERE id = ?", id);
      logAndSendWebhook("comment_destroyed", deletedComment);
      const response = {
        message: "Comment successfully deleted",
        deletedComment,
      };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
      }
      res.status(200).json(response);
    } catch (error) {
      logger.error(`Error destroying comment: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
