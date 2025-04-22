const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const config = require("config");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid"); // Adding ulid for request IDs
const {
  roditManager,
  stateManager,
  send_webhook,
} = require("../middleware/rodit");

const DB_PATH = config.get("API_OPTIONS.DB_PATH");

// Database connection
let db;

// Initialize database and export a function that can be awaited by app.js
const initializeDatabase = async () => {
  try {
    // Create context for database initialization
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
      content TEXT
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

// Combined function that logs and sends webhook
const logAndSendWebhook = async (event, data, isError = false) => {
  const requestId = ulid();
  const webhookContext = {
    event,
    requestId,
    isError,
    dataType: typeof data,
    operation: "webhook"
  };

  try {
    const result = await send_webhook(event, data, isError);

    if (result.isValid) {
      logger.infoWithContext("Webhook sent successfully", {
        ...webhookContext,
        status: "success"
      });
    } else {
      logger.errorWithContext(
        "Webhook send failed", 
        {
          ...webhookContext,
          status: "failed",
          errorMessage: result.error?.message
        },
        result.error
      );
    }

    // You can still log the event locally if needed
    logEvent(event, data, isError);
    
    return result;
  } catch (error) {
    logger.errorWithContext(
      "Exception occurred while sending webhook", 
      {
        ...webhookContext,
        status: "exception"
      }, 
      error
    );
    
    // Still log the event locally
    logEvent(event, data, isError);
    
    return { isValid: false, error, requestId };
  }
};

// Initialize the database when this module is loaded
initializeDatabase()
  .then(() => {
    logger.infoWithContext("CRUDA Router database initialized successfully", {
      module: "cruda_router",
      status: "ready"
    });
  })
  .catch((error) => {
    logger.errorWithContext(
      "Failed to initialize database", 
      {
        module: "cruda_router",
        status: "failed"
      },
      error
    );
    // Don't exit the process - let app.js handle errors
  });

// Middleware to check if the comment exists
const itemExists = async (req, res, next) => {
  const id = parseInt(req.body.id);
  const requestId = req.headers['x-request-id'] || ulid();
  
  const itemContext = {
    operation: "item_exists_check",
    requestId,
    itemId: id,
    method: req.method,
    path: req.path,
    ip: req.ip
  };
  
  logger.debugWithContext("Checking if item exists", itemContext);
  
  try {
    const comment = await db.get("SELECT * FROM comments WHERE id = ?", id);
    if (!comment) {
      const errorMessage = `Comment not found: ${id}`;
      
      logger.warnWithContext(
        "Comment not found", 
        {
          ...itemContext,
          status: "not_found"
        }
      );
      
      await logAndSendWebhook("comment_not_found", { id, error: errorMessage }, true);
      return res.status(404).json({ error: errorMessage });
    }
    
    logger.debugWithContext(
      "Comment found", 
      {
        ...itemContext,
        status: "found",
        commentTitle: comment.title
      }
    );
    
    req.comment = comment;
    req.requestId = requestId;
    next();
  } catch (error) {
    logger.errorWithContext(
      "Error checking if item exists", 
      itemContext,
      error
    );
    res.status(500).json({ error: "Internal server error" });
  }
};

// CREATE - Add a new comment
router.post(
  "/cruda/create",
  (req, res, next) => {
    req.logAction = "create_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    next();
  },
  async (req, res) => {
    const { title, content } = req.body;
    
    // Create context for create operation
    const createContext = {
      operation: "create_comment",
      requestId: req.requestId,
      action: req.logAction,
      hasTitle: !!title,
      hasContent: !!content,
      method: req.method,
      path: req.path,
      ip: req.ip
    };
    
    logger.infoWithContext("Processing create comment request", createContext);
    
    if (!title || !content) {
      const errorMessage = "Invalid create request: missing title or content";
      
      logger.warnWithContext(
        "Invalid create request", 
        {
          ...createContext,
          validation: "failed",
          missingTitle: !title,
          missingContent: !content
        }
      );
      
      await logAndSendWebhook("create_comment_error", { error: errorMessage }, true);
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
      
      logger.infoWithContext(
        "Comment created successfully", 
        {
          ...createContext,
          status: "success",
          commentId: result.lastID,
          titleLength: title.length,
          contentLength: content.length
        }
      );
      
      await logAndSendWebhook("comment_created", newItem);
      
      const response = { ...newItem };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext(
          "Added JWT token to response", 
          {
            ...createContext,
            tokenAdded: true
          }
        );
      }
      
      res.status(201).json(response);
    } catch (error) {
      logger.errorWithContext(
        "Error creating comment", 
        createContext,
        error
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// READ - Read all comments
router.post(
  "/cruda/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers['x-request-id'] || ulid();
    next();
  },
  async (req, res) => {
    // Create context for list operation
    const listContext = {
      operation: "list_comments",
      requestId: req.requestId,
      action: req.logAction,
      method: req.method,
      path: req.path,
      ip: req.ip
    };
    
    logger.infoWithContext("Processing list comments request", listContext);
    
    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;
      
      logger.infoWithContext(
        "Comments retrieved successfully", 
        {
          ...listContext,
          status: "success",
          count: itemCount
        }
      );
      
      await logAndSendWebhook("comments_listed", { count: itemCount });
      
      const response = { comments };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext(
          "Added JWT token to response", 
          {
            ...listContext,
            tokenAdded: true
          }
        );
      }
      
      res.json(response);
    } catch (error) {
      logger.errorWithContext(
        "Error listing comments", 
        listContext,
        error
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// READ - Read a specific comment
router.post(
  "/cruda/read",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    next();
  },
  itemExists,
  (req, res, next) => {
    req.logAction = "read_item";
    next();
  },
  (req, res) => {
    // Create context for read operation
    const readContext = {
      operation: "read_comment",
      requestId: req.requestId,
      action: req.logAction,
      commentId: req.comment.id,
      method: req.method,
      path: req.path,
      ip: req.ip
    };
    
    logger.infoWithContext("Processing read comment request", readContext);
    
    logAndSendWebhook("comment_read", req.comment);
    
    logger.infoWithContext(
      "Comment retrieved successfully", 
      {
        ...readContext,
        status: "success",
        commentTitle: req.comment.title
      }
    );
    
    const response = { ...req.comment };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
      logger.debugWithContext(
        "Added JWT token to response", 
        {
          ...readContext,
          tokenAdded: true
        }
      );
    }
    
    res.json(response);
  }
);

// UPDATE - Update a comment
router.post(
  "/cruda/update",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    next();
  },
  itemExists,
  (req, res, next) => {
    req.logAction = "update_item";
    next();
  },
  async (req, res) => {
    const { id, title, content } = req.body;
    const oldComment = { ...req.comment };
    
    // Create context for update operation
    const updateContext = {
      operation: "update_comment",
      requestId: req.requestId,
      action: req.logAction,
      commentId: id,
      titleUpdated: title !== undefined,
      contentUpdated: content !== undefined,
      method: req.method,
      path: req.path,
      ip: req.ip
    };
    
    logger.infoWithContext("Processing update comment request", updateContext);
    
    try {
      await db.run(
        "UPDATE comments SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?",
        [title, content, id]
      );
      
      const updatedComment = await db.get(
        "SELECT * FROM comments WHERE id = ?",
        id
      );
      
      logger.infoWithContext(
        "Comment updated successfully", 
        {
          ...updateContext,
          status: "success",
          oldTitleLength: oldComment.title.length,
          newTitleLength: updatedComment.title.length,
          oldContentLength: oldComment.content.length,
          newContentLength: updatedComment.content.length
        }
      );
      
      await logAndSendWebhook("comment_updated", {
        id: updatedComment.id,
        oldTitle: oldComment.title,
        newTitle: updatedComment.title,
        oldContent: oldComment.content,
        newContent: updatedComment.content,
      });
      
      const response = { ...updatedComment };
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext(
          "Added JWT token to response", 
          {
            ...updateContext,
            tokenAdded: true
          }
        );
      }
      
      res.json(response);
    } catch (error) {
      logger.errorWithContext(
        "Error updating comment", 
        updateContext,
        error
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DESTROY - Destroy a comment
router.post(
  "/cruda/destroy",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    next();
  },
  itemExists,
  (req, res, next) => {
    req.logAction = "destroy_item";
    next();
  },
  async (req, res) => {
    const { id } = req.body;
    
    // Create context for destroy operation
    const destroyContext = {
      operation: "destroy_comment",
      requestId: req.requestId,
      action: req.logAction,
      commentId: id,
      method: req.method,
      path: req.path,
      ip: req.ip
    };
    
    logger.infoWithContext("Processing destroy comment request", destroyContext);
    
    try {
      const deletedComment = { ...req.comment };
      await db.run("DELETE FROM comments WHERE id = ?", id);
      
      logger.infoWithContext(
        "Comment destroyed successfully", 
        {
          ...destroyContext,
          status: "success",
          commentTitle: deletedComment.title
        }
      );
      
      await logAndSendWebhook("comment_destroyed", deletedComment);
      
      const response = {
        message: "Comment successfully deleted",
        deletedComment,
      };
      
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext(
          "Added JWT token to response", 
          {
            ...destroyContext,
            tokenAdded: true
          }
        );
      }
      
      res.status(200).json(response);
    } catch (error) {
      logger.errorWithContext(
        "Error destroying comment", 
        destroyContext,
        error
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Export functions to allow proper cleanup in app.js
router.closeDatabase = async () => {
  if (db) {
    try {
      await db.close();
      logger.infoWithContext("Database connection closed", {
        operation: "db_close",
        module: "cruda_router",
        status: "success"
      });
    } catch (error) {
      logger.errorWithContext(
        "Error closing database", 
        {
          operation: "db_close",
          module: "cruda_router",
          status: "failed"
        },
        error
      );
      throw error;
    }
  }
};

module.exports = router;