const express = require("express");
const router = express.Router();
const logger = require("../config/logger");
const config = require("config");
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
  set_rodit_config,
  get_rodit_config,
  send_webhook,
} = require("../middleware/rodit");

const RODIT_CONFIGURATION_FILE_PATH = config.get(
  "RODIT_CONFIGURATION_FILE_PATH"
);

let db;

// Initialization function
const initializeRouter = async () => {
  try {
    await set_rodit_config(RODIT_CONFIGURATION_FILE_PATH);
    const config = await get_rodit_config();
    logger.info("Rodit configuration initialized successfully");

    // Initialize SQLite database
    db = await open({
      filename: './database.sqlite',
      driver: sqlite3.Database
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
    logger.info(`Webhook sent successfully - Event: ${event}, Request ID: ${result.requestId}`);
  } else {
    logger.error(`Webhook send failed - Event: ${event}, Error: ${result.error.message}, Request ID: ${result.requestId}`);
  }
  
  // You can still log the event locally if needed
  logEvent(event, data, isError, result.requestId);
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

// Middleware to check if the comment exists
const itemExists = async (req, res, next) => {
  const id = parseInt(req.body.id);
  try {
    const comment = await db.get('SELECT * FROM comments WHERE id = ?', id);
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
        'INSERT INTO comments (title, content) VALUES (?, ?)',
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
      const comments = await db.all('SELECT * FROM comments');
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
        'UPDATE comments SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?',
        [title, content, id]
      );
      const updatedComment = await db.get('SELECT * FROM comments WHERE id = ?', id);
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
      await db.run('DELETE FROM comments WHERE id = ?', id);
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