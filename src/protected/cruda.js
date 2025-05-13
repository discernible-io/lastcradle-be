const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const config = require("config");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid");
const crypto = require("crypto");
const {
  authenticate_apicall,
  stateManager
} = require("../middleware/rodit");

const DB_PATH = config.get("API_OPTIONS.DB_PATH");

// Database connection
let db;

// Initialize database and export a function that can be awaited by app.js
const initializeDatabase = async () => {
  const dbContext = {
    operation: "db_initialization",
    dbPath: DB_PATH,
    module: "cruda_router"
  };

  try {
    // Initialize SQLite database
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    // Create comments table if it doesn't exist
    await db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create webhook_tests table to track webhook test results
    await db.run(`CREATE TABLE IF NOT EXISTS webhook_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      timestamp TEXT NOT NULL,
      error_message TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    logger.info("SQLite database initialized successfully", dbContext);
    return db;
  } catch (error) {
    logger.error("Error initializing SQLite database", {
      ...dbContext,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
};

// Expose the database connection for proper cleanup in app.js
const getDatabase = () => db;

// Helper function to create request context
const createRequestContext = (req, operation) => ({
  operation,
  requestId: req.headers['x-request-id'] || ulid(),
  userId: req.user?.sub || 'anonymous',
  userRoles: req.user?.roles || [],
  endpoint: req.originalUrl,
  method: req.method,
  ip: req.ip
});

// Middleware to check if the comment exists
const itemExists = async (req, res, next) => {
  const context = createRequestContext(req, 'check_item_exists');
  const { id } = req.body;

  if (!id) {
    logger.warn("Missing comment ID", context);
    return res.status(400).json({ error: "Comment ID is required" });
  }

  try {
    const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
    if (!comment) {
      logger.warn("Comment not found", { ...context, commentId: id });
      return res.status(404).json({ error: "Comment not found" });
    }

    // Attach comment to request for use in subsequent middleware
    req.comment = comment;
    next();
  } catch (error) {
    logger.error("Error checking if comment exists", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: "Internal server error" });
  }
};

// Apply authentication middleware to all routes
router.use(authenticate_apicall);

// CREATE - Add a new comment
router.post("/create", async (req, res) => {
  const context = createRequestContext(req, 'create_comment');
  const { title, content } = req.body;

  // Input validation
  if (!title || !content) {
    logger.warn("Missing required fields", context);
    return res.status(400).json({ error: "Title and content are required" });
  }

  try {
    const result = await db.run(
      "INSERT INTO comments (title, content, created_by) VALUES (?, ?, ?)",
      [title, content, req.user?.sub || 'system']
    );

    const newComment = await db.get("SELECT * FROM comments WHERE id = ?", [result.lastID]);
    
    logger.info("Comment created successfully", {
      ...context,
      commentId: result.lastID
    });

    res.status(201).json(newComment);
  } catch (error) {
    logger.error("Error creating comment", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: "Failed to create comment" });
  }
});

// READ - Get all comments
router.get("/list", async (req, res) => {
  const context = createRequestContext(req, 'list_comments');
  
  try {
    const comments = await db.all("SELECT * FROM comments ORDER BY created_at DESC");
    logger.info("Retrieved comments successfully", {
      ...context,
      count: comments.length
    });
    res.json(comments);
  } catch (error) {
    logger.error("Error retrieving comments", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: "Failed to retrieve comments" });
  }
});

// UPDATE - Update a comment
router.put("/update", itemExists, async (req, res) => {
  const context = createRequestContext(req, 'update_comment');
  const { id, title, content } = req.body;

  // Input validation
  if (!title && !content) {
    logger.warn("No fields to update", context);
    return res.status(400).json({ error: "No fields to update" });
  }

  try {
    // Check if user is authorized to update this comment
    if (req.comment.created_by !== req.user?.sub && !req.user?.roles?.includes('admin')) {
      logger.warn("Unauthorized update attempt", {
        ...context,
        commentOwner: req.comment.created_by,
        currentUser: req.user?.sub
      });
      return res.status(403).json({ error: "Not authorized to update this comment" });
    }

    const updateFields = [];
    const params = [];

    if (title) {
      updateFields.push("title = ?");
      params.push(title);
    }
    if (content) {
      updateFields.push("content = ?");
      params.push(content);
    }

    params.push(id);
    
    await db.run(
      `UPDATE comments SET ${updateFields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      params
    );

    const updatedComment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
    
    logger.info("Comment updated successfully", {
      ...context,
      commentId: id
    });

    res.json(updatedComment);
  } catch (error) {
    logger.error("Error updating comment", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: "Failed to update comment" });
  }
});

// DELETE - Delete a comment
router.delete("/delete", itemExists, async (req, res) => {
  const context = createRequestContext(req, 'delete_comment');
  const { id } = req.body;

  try {
    // Check if user is authorized to delete this comment
    if (req.comment.created_by !== req.user?.sub && !req.user?.roles?.includes('admin')) {
      logger.warn("Unauthorized delete attempt", {
        ...context,
        commentOwner: req.comment.created_by,
        currentUser: req.user?.sub
      });
      return res.status(403).json({ error: "Not authorized to delete this comment" });
    }

    await db.run("DELETE FROM comments WHERE id = ?", [id]);
    
    logger.info("Comment deleted successfully", {
      ...context,
      commentId: id
    });

    res.status(204).send();
  } catch (error) {
    logger.error("Error deleting comment", {
      ...context,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// Initialize the database when this module is loaded
initializeDatabase()
  .then(() => {
    logger.info("CRUDA Router database initialized successfully");
  })
  .catch((error) => {
    logger.error("Failed to initialize CRUDA Router database", {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });

// Handle process termination
process.on('SIGTERM', async () => {
  try {
    if (db) {
      await db.close();
      logger.info("Database connection closed gracefully");
    }
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown", {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
});

// Export the router and attach getDatabase as a property
const crudaRouter = router;
crudaRouter.getDatabase = getDatabase;
module.exports = crudaRouter;