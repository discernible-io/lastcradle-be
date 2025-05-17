const express = require("express");
const router = express.Router();
const logger = require("../../config/logger");
const config = require("config");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid"); // Adding ulid for request IDs
const crypto = require("crypto");
const {
  stateManager
} = require("../middleware/rodit");
const { send_webhook } = require("../auth/authentication");

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

    // Create webhook_tests table to track webhook test results
    await db.run(`CREATE TABLE IF NOT EXISTS webhook_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT,
      event_type TEXT,
      payload TEXT,
      success BOOLEAN,
      timestamp TEXT,
      error_message TEXT
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

// Enhanced function that logs, sends webhook, and tracks test results
const logAndSendWebhook = async (event, data, isError = false, isTest = false, req = null) => {
  const requestId = data.test_id || ulid();
  const webhookContext = {
    event,
    requestId,
    isError,
    isTest,
    dataType: typeof data,
    operation: "webhook"
  };

  try {
    // Log the webhook attempt
    logger.infoWithContext("Sending webhook", {
      ...webhookContext,
      status: "attempt",
      eventType: event
    });

    // Use the imported send_webhook function from the rodit middleware
    // This avoids duplicating the complex logic for webhook generation
    const result = await send_webhook(event, data, isError, req);

    // Save test results if this is a test
    if (isTest && db) {
      try {
        await db.run(
          `INSERT INTO webhook_tests (correlation_id, event_type, payload, success, timestamp, error_message) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            event,
            JSON.stringify(data),
            result.isValid ? 1 : 0,
            new Date().toISOString(),
            result.error ? result.error.message || JSON.stringify(result.error) : null
          ]
        );

        logger.infoWithContext("Webhook test result recorded", {
          ...webhookContext,
          status: result.isValid ? "success" : "failure",
          databaseRecorded: true
        });
      } catch (dbError) {
        logger.errorWithContext(
          "Failed to record webhook test result", 
          {
            ...webhookContext,
            status: "database_error"
          },
          dbError
        );
      }
    }

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

    // Log the event locally
    logEvent(event, data, isError);
    
    return { ...result, requestId };
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

    // Save test failure if this is a test
    if (isTest && db) {
      try {
        await db.run(
          `INSERT INTO webhook_tests (correlation_id, event_type, payload, success, timestamp, error_message) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            event,
            JSON.stringify(data),
            0,
            new Date().toISOString(),
            error.message || JSON.stringify(error)
          ]
        );
      } catch (dbError) {
        logger.errorWithContext(
          "Failed to record webhook test failure", 
          {
            ...webhookContext,
            status: "database_error"
          },
          dbError
        );
      }
    }
    
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
      
      // Determine if this is part of a test
      const isTest = req.headers['x-webhook-test'] === 'true';
      
      // Pass the request object to logAndSendWebhook
      await logAndSendWebhook("comment_not_found", { 
        id, 
        error: errorMessage,
        test_id: isTest ? requestId : undefined
      }, true, isTest, req);
      
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
  "/create",
  (req, res, next) => {
    req.logAction = "create_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.isWebhookTest = req.headers['x-webhook-test'] === 'true';
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
      ip: req.ip,
      isTest: req.isWebhookTest
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
      
      // Pass the request object to logAndSendWebhook
      await logAndSendWebhook("create_comment_error", { 
        error: errorMessage,
        test_id: req.isWebhookTest ? req.requestId : undefined
      }, true, req.isWebhookTest, req);
      
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
      
      // Add test_id for webhook tracking if this is a test
      if (req.isWebhookTest) {
        newItem.test_id = req.requestId;
      }
      
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
      
      // Send the webhook with additional test flag and pass the request object
      const webhookResult = await logAndSendWebhook("comment_created", newItem, false, req.isWebhookTest, req);
      
      const response = { ...newItem };
      
      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null
        };
      }
      
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
  "/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.isWebhookTest = req.headers['x-webhook-test'] === 'true';
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
      ip: req.ip,
      isTest: req.isWebhookTest
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
      
      // Send webhook with test flag if needed and pass the request object
      const webhookPayload = { 
        count: itemCount,
        test_id: req.isWebhookTest ? req.requestId : undefined
      };
      
      const webhookResult = await logAndSendWebhook("comments_listed", webhookPayload, false, req.isWebhookTest, req);
      
      const response = { comments };
      
      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null
        };
      }
      
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
  "/read",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    req.isWebhookTest = req.headers['x-webhook-test'] === 'true';
    next();
  },
  itemExists,
  (req, res, next) => {
    req.logAction = "read_item";
    next();
  },
  async (req, res) => {
    // Create context for read operation
    const readContext = {
      operation: "read_comment",
      requestId: req.requestId,
      action: req.logAction,
      commentId: req.comment.id,
      method: req.method,
      path: req.path,
      ip: req.ip,
      isTest: req.isWebhookTest
    };
    
    logger.infoWithContext("Processing read comment request", readContext);
    
    // Add test_id for webhook tracking if this is a test
    const commentData = { ...req.comment };
    if (req.isWebhookTest) {
      commentData.test_id = req.requestId;
    }
    
    // Send the webhook with test flag if needed and pass the request object
    const webhookResult = await logAndSendWebhook("comment_read", commentData, false, req.isWebhookTest, req);
    
    logger.infoWithContext(
      "Comment retrieved successfully", 
      {
        ...readContext,
        status: "success",
        commentTitle: req.comment.title,
        webhookSent: webhookResult.isValid
      }
    );
    
    const response = { ...req.comment };
    
    // If this is a test, include webhook result info
    if (req.isWebhookTest) {
      response.webhook_result = {
        success: webhookResult.isValid,
        correlation_id: webhookResult.requestId,
        error: webhookResult.error ? webhookResult.error.message : null
      };
    }
    
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
  "/update",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    req.isWebhookTest = req.headers['x-webhook-test'] === 'true';
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
      ip: req.ip,
      isTest: req.isWebhookTest
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
      
      // Prepare webhook payload
      const webhookPayload = {
        id: updatedComment.id,
        oldTitle: oldComment.title,
        newTitle: updatedComment.title,
        oldContent: oldComment.content,
        newContent: updatedComment.content,
      };
      
      // Add test_id for webhook tracking if this is a test
      if (req.isWebhookTest) {
        webhookPayload.test_id = req.requestId;
      }
      
      // Send the webhook with test flag if needed and pass the request object
      const webhookResult = await logAndSendWebhook("comment_updated", webhookPayload, false, req.isWebhookTest, req);
      
      const response = { ...updatedComment };
      
      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null
        };
      }
      
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
  "/destroy",
  (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || ulid();
    req.isWebhookTest = req.headers['x-webhook-test'] === 'true';
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
      ip: req.ip,
      isTest: req.isWebhookTest
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
      
      // Add test_id for webhook tracking if this is a test
      if (req.isWebhookTest) {
        deletedComment.test_id = req.requestId;
      }
      
      // Send the webhook with test flag if needed and pass the request object
      const webhookResult = await logAndSendWebhook("comment_destroyed", deletedComment, false, req.isWebhookTest, req);
      
     // DESTROY - Destroy a comment (continued)
      // In the previous section, we ended at this point
      const response = {
        message: "Comment successfully deleted",
        deletedComment,
      };
      
      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null
        };
      }
      
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

// Test webhook connectivity directly
router.post(
  "/webhook-test",
  async (req, res) => {
    const requestId = req.headers['x-request-id'] || ulid();
    
    const testContext = {
      operation: "webhook_direct_test",
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous"
    };
    
    logger.infoWithContext("Processing direct webhook test request", testContext);
    
    try {
      // Get webhook URL configuration
      const config = await stateManager.getConfigOwnRodit();
      if (!config || !config.own_rodit || !config.own_rodit.metadata || !config.own_rodit.metadata.webhook_url) {
        logger.warnWithContext(
          "No webhook URL configured", 
          {
            ...testContext,
            status: "no_webhook_url"
          }
        );
        
        return res.status(400).json({
          success: false,
          error: "No webhook URL configured in system"
        });
      }
      
      // Create test payload
      const testPayload = {
        event: "webhook_connectivity_test",
        timestamp: new Date().toISOString(),
        test_id: requestId,
        origin: "direct_test",
        data: {
          message: "This is a webhook connectivity test"
        }
      };
      
      // Send a test webhook - pass the request object
      const webhookResult = await logAndSendWebhook("webhook_test", testPayload, false, true, req);
      
      // Record the test in the database
      try {
        await db.run(
          `INSERT INTO webhook_tests (correlation_id, event_type, payload, success, timestamp, error_message) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            "webhook_test",
            JSON.stringify(testPayload),
            webhookResult.isValid ? 1 : 0,
            new Date().toISOString(),
            webhookResult.error ? webhookResult.error.message || JSON.stringify(webhookResult.error) : null
          ]
        );
        
        logger.infoWithContext("Direct webhook test recorded in database", {
          ...testContext,
          status: "database_record_created"
        });
      } catch (dbError) {
        logger.errorWithContext(
          "Failed to record webhook test in database", 
          {
            ...testContext,
            status: "database_error"
          },
          dbError
        );
      }
      
      // Use a clean webhook URL for display (don't show duplicated https://)
      const displayWebhookUrl = config.own_rodit.metadata.webhook_url.replace(/^(https?:\/\/)/, "");
      
      res.json({
        success: webhookResult.isValid,
        webhookUrl: displayWebhookUrl,
        correlation_id: requestId,
        timestamp: new Date().toISOString(),
        error: webhookResult.error ? webhookResult.error.message : null
      });
    } catch (error) {
      logger.errorWithContext(
        "Error in direct webhook test", 
        testContext,
        error
      );
      
      res.status(500).json({
        success: false,
        error: "Failed to execute webhook test: " + error.message
      });
    }
  }
);

// Get webhook test results
router.get(
  "/webhook-test-results",
  async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    
    const requestId = req.headers['x-request-id'] || ulid();
    
    const testContext = {
      operation: "get_webhook_test_results",
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous",
      limit
    };
    
    logger.infoWithContext("Retrieving webhook test results", testContext);
    
    try {
      const results = await db.all(
        `SELECT * FROM webhook_tests ORDER BY timestamp DESC LIMIT ?`, 
        [limit]
      );
      
      // Parse JSON payloads
      const formattedResults = results.map(result => ({
        ...result,
        payload: result.payload ? JSON.parse(result.payload) : null,
        success: !!result.success  // Convert to boolean
      }));
      
      logger.infoWithContext(
        "Retrieved webhook test results", 
        {
          ...testContext,
          status: "success",
          count: results.length
        }
      );
      
      res.json({
        success: true,
        results: formattedResults,
        count: formattedResults.length
      });
    } catch (error) {
      logger.errorWithContext(
        "Error retrieving webhook test results", 
        testContext,
        error
      );
      
      res.status(500).json({
        success: false,
        error: "Failed to retrieve webhook test results: " + error.message
      });
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

// Export the database getter
router.getDatabase = getDatabase;

module.exports = router;