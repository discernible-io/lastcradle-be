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
  send_webhook,
  authenticate_webhook,
  stateManager,
  roditManager
} = require("../middleware/rodit");

const DB_PATH = config.get("API_OPTIONS.DB_PATH");

// Database connection
let db;

// Initialize database and export a function that can be awaited by app.js
const initializeDatabase = async () => {
  try {
    const dbContext = {
      operation: "db_initialization",
      dbPath: DB_PATH,
      module: "cruda_router"
    };

    // Initialize SQLite database
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    // Create comments table if it doesn't exist
    await db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create webhook_tests table to track webhook test results
    await db.run(`CREATE TABLE IF NOT EXISTS webhook_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT,
      event_type TEXT,
      payload TEXT,
      success BOOLEAN,
      timestamp TEXT,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    logger.infoWithContext("SQLite database initialized successfully", dbContext);
    return db;
  } catch (error) {
    const errorContext = {
      operation: "db_initialization",
      dbPath: DB_PATH,
      module: "cruda_router"
    };
    logger.errorWithContext("Error initializing SQLite database", errorContext, error);
    throw error;
  }
};

// Expose the database connection for proper cleanup in app.js
const getDatabase = () => db;

// Log events with structured context
const logEvent = (event, data, isError = false) => {
  const context = {
    event,
    dataType: typeof data,
    dataSize: JSON.stringify(data).length,
    hasData: !!data
  };

  if (isError) {
    logger.errorWithContext(`Database event: ${event}`, context, data.error || new Error(event));
  } else {
    logger.infoWithContext(`Database event: ${event}`, context);
  }
  
  // Log detailed data at debug level
  logger.debugWithContext(`Event data detail`, {
    ...context,
    data
  });
};

// Middleware to check if the comment exists
const itemExists = async (req, res, next) => {
  const { id } = req.body;
  const requestId = req.headers['x-request-id'] || ulid();
  
  const context = {
    operation: "check_item_exists",
    requestId,
    itemId: id,
    method: req.method,
    path: req.path
  };

  try {
    if (!id) {
      logger.warnWithContext("Missing ID in request", context);
      return res.status(400).json({ error: "ID is required" });
    }

    const item = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
    
    if (!item) {
      logger.warnWithContext("Item not found", { ...context, status: 404 });
      return res.status(404).json({ error: "Item not found" });
    }

    // Attach the item to the request for use in subsequent middleware
    req.item = item;
    logger.debugWithContext("Item found", { ...context, itemId: item.id });
    next();
  } catch (error) {
    const errorContext = {
      ...context,
      error: error.message,
      stack: error.stack
    };
    logger.errorWithContext("Error checking if item exists", errorContext, error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Apply authentication middleware to all routes
router.use(authenticate_apicall);

// CREATE - Add a new comment
router.post("/create", async (req, res) => {
  const { title, content } = req.body;
  const requestId = req.headers['x-request-id'] || ulid();
  
  const context = {
    operation: "create_comment",
    requestId,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip
  };

  try {
    if (!title || !content) {
      logger.warnWithContext("Missing required fields", context);
      return res.status(400).json({ error: "Title and content are required" });
    }

    const result = await db.run(
      "INSERT INTO comments (title, content) VALUES (?, ?)",
      [title, content]
    );

    const newItem = await db.get("SELECT * FROM comments WHERE id = ?", [result.lastID]);
    
    // Log the creation event
    logEvent("comment_created", newItem);
    
    // Send webhook notification
    try {
      await send_webhook("comment.created", newItem, false, req);
    } catch (webhookError) {
      logger.errorWithContext("Webhook notification failed", {
        ...context,
        error: webhookError.message
      }, webhookError);
    }

    logger.infoWithContext("Comment created successfully", {
      ...context,
      commentId: newItem.id
    });
    
    res.status(201).json(newItem);
  } catch (error) {
    logger.errorWithContext("Error creating comment", {
      ...context,
      error: error.message,
      stack: error.stack
    }, error);
    res.status(500).json({ error: "Failed to create comment" });
  }
});

// READ - Get all comments
router.post("/list", async (req, res) => {
  const requestId = req.headers['x-request-id'] || ulid();
  const context = {
    operation: "list_comments",
    requestId,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip
  };

  try {
    const items = await db.all("SELECT * FROM comments ORDER BY created_at DESC");
    
    logger.infoWithContext("Retrieved comments list", {
      ...context,
      count: items.length
    });
    
    res.json(items);
  } catch (error) {
    logger.errorWithContext("Error retrieving comments", {
      ...context,
      error: error.message,
      stack: error.stack
    }, error);
    res.status(500).json({ error: "Failed to retrieve comments" });
  }
});

// UPDATE - Update a comment
router.post("/update", itemExists, async (req, res) => {
  const { id, title, content } = req.body;
  const requestId = req.headers['x-request-id'] || ulid();
  
  const context = {
    operation: "update_comment",
    requestId,
    itemId: id,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip
  };

  try {
    const updateFields = [];
    const params = [];
    
    if (title !== undefined) {
      updateFields.push("title = ?");
      params.push(title);
    }
    
    if (content !== undefined) {
      updateFields.push("content = ?");
      params.push(content);
    }
    
    if (updateFields.length === 0) {
      logger.warnWithContext("No fields to update", context);
      return res.status(400).json({ error: "No fields to update" });
    }
    
    // Add updated_at timestamp
    updateFields.push("updated_at = CURRENT_TIMESTAMP");
    
    // Add the WHERE condition
    params.push(id);
    
    const query = `UPDATE comments SET ${updateFields.join(", ")} WHERE id = ?`;
    
    await db.run(query, params);
    const updatedItem = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
    
    // Log the update event
    logEvent("comment_updated", updatedItem);
    
    // Send webhook notification
    try {
      await send_webhook("comment.updated", updatedItem, false, req);
    } catch (webhookError) {
      logger.errorWithContext("Webhook notification failed", {
        ...context,
        error: webhookError.message
      }, webhookError);
    }

    logger.infoWithContext("Comment updated successfully", {
      ...context,
      updatedFields: updateFields.filter(f => !f.includes('updated_at'))
    });
    
    res.json(updatedItem);
  } catch (error) {
    logger.errorWithContext("Error updating comment", {
      ...context,
      error: error.message,
      stack: error.stack
    }, error);
    res.status(500).json({ error: "Failed to update comment" });
  }
});

// DELETE - Delete a comment
router.post("/destroy", itemExists, async (req, res) => {
  const { id } = req.body;
  const requestId = req.headers['x-request-id'] || ulid();
  
  const context = {
    operation: "delete_comment",
    requestId,
    itemId: id,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip
  };

  try {
    // Store the item before deletion for webhook
    const deletedItem = { ...req.item };
    
    await db.run("DELETE FROM comments WHERE id = ?", [id]);
    
    // Log the deletion event
    logEvent("comment_deleted", { id });
    
    // Send webhook notification
    try {
      await send_webhook("comment.deleted", deletedItem, false, req);
    } catch (webhookError) {
      logger.errorWithContext("Webhook notification failed", {
        ...context,
        error: webhookError.message
      }, webhookError);
    }

    logger.infoWithContext("Comment deleted successfully", context);
    
    res.status(204).send();
  } catch (error) {
    logger.errorWithContext("Error deleting comment", {
      ...context,
      error: error.message,
      stack: error.stack
    }, error);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

// Webhook test endpoint
router.post("/webhook-test", async (req, res) => {
  const { event, data, isError } = req.body;
  const requestId = req.headers['x-request-id'] || ulid();
  
  const context = {
    operation: "webhook_test",
    requestId,
    event,
    isError: !!isError,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip
  };

  try {
    if (!event) {
      logger.warnWithContext("Missing event in webhook test", context);
      return res.status(400).json({ error: "Event is required" });
    }

    // Store the test result in the database
    const correlationId = ulid();
    const testResult = {
      correlation_id: correlationId,
      event_type: event,
      payload: JSON.stringify(data || {}),
      success: !isError,
      timestamp: new Date().toISOString(),
      error_message: isError ? "Test error" : null
    };

    await db.run(
      `INSERT INTO webhook_tests 
       (correlation_id, event_type, payload, success, timestamp, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        testResult.correlation_id,
        testResult.event_type,
        testResult.payload,
        testResult.success ? 1 : 0,
        testResult.timestamp,
        testResult.error_message
      ]
    );

    // Send the actual webhook using the new implementation
    try {
      await send_webhook(event, data || {}, isError, req);
      
      logger.infoWithContext("Webhook test completed successfully", {
        ...context,
        correlationId
      });
      
      res.json({
        success: true,
        correlation_id: correlationId,
        message: "Webhook test completed successfully"
      });
    } catch (webhookError) {
      logger.errorWithContext("Webhook test failed", {
        ...context,
        error: webhookError.message,
        stack: webhookError.stack
      }, webhookError);
      
      res.status(500).json({
        success: false,
        correlation_id: correlationId,
        error: `Webhook test failed: ${webhookError.message}`
      });
    }
  } catch (error) {
    logger.errorWithContext("Error processing webhook test", {
      ...context,
      error: error.message,
      stack: error.stack
    }, error);
    
    res.status(500).json({
      success: false,
      error: "Failed to process webhook test"
    });
  }
});

// Close database connection on application shutdown
const closeDatabase = async () => {
  try {
    if (db) {
      await db.close();
      logger.infoWithContext("Database connection closed", {
        module: "cruda_router"
      });
    }
  } catch (error) {
    logger.errorWithContext("Error closing database connection", {
      module: "cruda_router",
      error: error.message,
      stack: error.stack
    }, error);
    throw error;
  }
};

// Initialize the database when this module is loaded
initializeDatabase()
  .then(() => {
    logger.infoWithContext("CRUDA Router database initialized successfully", {
      module: "cruda_router"
    });
  })
  .catch((error) => {
    logger.errorWithContext("Failed to initialize CRUDA Router database", {
      module: "cruda_router",
      error: error.message,
      stack: error.stack
    }, error);
    // Exit the process if database initialization fails
    process.exit(1);
  });

// Handle process termination
process.on('SIGINT', async () => {
  logger.infoWithContext("SIGINT received, closing database connection", {
    module: "cruda_router"
  });
  await closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.infoWithContext("SIGTERM received, closing database connection", {
    module: "cruda_router"
  });
  await closeDatabase();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.errorWithContext("Uncaught exception", {
    module: "cruda_router",
    error: error.message,
    stack: error.stack
  }, error);
  
  try {
    await closeDatabase();
  } finally {
    process.exit(1);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.errorWithContext("Unhandled promise rejection", {
    module: "cruda_router",
    reason: reason?.message || String(reason),
    stack: reason?.stack
  }, reason);
});

// Export the router and database functions
router.getDatabase = getDatabase;
router.closeDatabase = closeDatabase;

module.exports = router;