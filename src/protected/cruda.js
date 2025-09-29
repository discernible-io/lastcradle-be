const express = require("express");
const router = express.Router();
const { RoditClient } = require("@rodit/rodit-auth-be");

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();
const webhook = sdkClient.getWebhookHandler();
const logger = sdkClient.getLogger();
const config = require("config");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid"); // Adding ulid for request IDs
const { createLogContext, logErrorWithMetrics, debugWithContextIf } = logger;

const DB_PATH = config.get("API_DEFAULT_OPTIONS.DB_PATH");

// Database connection
let db;

// Initialize database and export a function that can be awaited by app.js
const initializeDatabase = async () => {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: 'CRUDARouter',
    method: 'initializeDatabase',
    dbPath: DB_PATH
  });
  
  logger.debugWithContext("Starting database initialization", baseContext);
  
  try {
    // Initialize SQLite database
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    // Create comments table if it doesn't exist
    await db.run(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment TEXT NOT NULL,
      author TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const duration = Date.now() - startTime;
    logger.infoWithContext("SQLite database initialized successfully", {
      ...baseContext,
      duration
    });

    // Add metric for successful operation
    logger.metric('database_operations', duration, {
      operation: 'initializeDatabase',
      result: 'success'
    });

    return db;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error initializing SQLite database",
      {
        ...baseContext,
        duration
      },
      error,
      'database_error',
      {
        operation: 'initializeDatabase',
        result: 'error',
        duration
      }
    );
    throw error;
  }
};

// Expose the database connection for proper cleanup in app.js
const getDatabase = () => db;

// Forward function to use the SDK's webhook sender with simplified interface (payload, req)
// payload shape: { event: string, data?: any, isError?: boolean }
const logAndSendWebhook = async (payload, req = null) => {
  try {
    // Use the roditClient from app.locals instead of direct webhook import
    const roditClient = req?.app?.locals?.roditClient;
    if (!roditClient) {
      logger.warn('RoditClient not available in app.locals, skipping webhook', {
        component: 'CRUDA',
        event: payload?.event,
        requestId: req?.requestId
      });
      return { success: false, error: 'RoditClient not available' };
    }
    
    // Call send_webhook with payload object and request
    return await roditClient.send_webhook(payload, req);
  } catch (error) {
    // Log the webhook failure but don't let it crash the application
    logger.warn('Webhook delivery failed, continuing with request processing', {
      component: 'CRUDA',
      event: payload?.event,
      error: {
        name: error.name,
        message: error.message
      },
      requestId: req?.requestId
    });
    
    // Return a failure result instead of throwing
    return { 
      success: false, 
      error: error.message,
      errorType: error.name 
    };
  }
};

// Initialize the database when this module is loaded
initializeDatabase()
  .then(() => {
    const requestId = ulid();
    logger.infoWithContext(
      "CRUDA Router database initialized successfully", 
      createLogContext({
        requestId,
        component: 'CRUDARouter',
        method: 'moduleInitialization',
        status: "ready"
      })
    );
  })
  .catch((error) => {
    const requestId = ulid();
    logErrorWithMetrics(
      "Failed to initialize database",
      createLogContext({
        requestId,
        component: 'CRUDARouter',
        method: 'moduleInitialization',
        status: "failed"
      }),
      error,
      'database_error',
      {
        operation: 'moduleInitialization',
  });
});

// 404 handler for undefined routes
router.use((req, res) => {
  const requestId = req.requestId || ulid();
  res.status(404).json({
    error: "Not Found",
    message: `Cannot ${req.method} ${req.path}`,
    requestId
  });
});

// Middleware to check if item exists
const itemExists = async (req, res, next) => {
  const requestId = req.requestId || ulid();
  const { id } = req.body;
  
  if (!id) {
    logger.warn("Item existence check failed - no ID provided", {
      component: 'CRUDARouter',
      method: 'itemExists',
      requestId,
      bodyKeys: Object.keys(req.body || {})
    });
    
    return res.status(400).json({
      error: "ID is required",
      requestId
    });
  }
  
  try {
    const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
    
    if (!comment) {
      logger.warn("Item not found", {
        component: 'CRUDARouter',
        method: 'itemExists',
        requestId,
        itemId: id
      });
      
      return res.status(404).json({
        error: "Comment not found",
        requestId
      });
    }
    
    req.comment = comment;
    next();
  } catch (error) {
    logErrorWithMetrics(
      "Error checking item existence",
      {
        component: 'CRUDARouter',
        method: 'itemExists',
        requestId,
        itemId: id
      },
      error,
      'cruda_error',
      {
        operation: 'itemExists',
        result: 'error'
      }
    );
    
    res.status(500).json({
      error: "Internal server error",
      requestId
    });
  }
};

// In-memory store for idempotency keys (in production, use Redis or database)
const idempotencyStore = new Map();

// Middleware to handle idempotency
const handleIdempotency = (req, res, next) => {
  const idempotencyKey = req.headers['idempotency-key'];
  
  if (!idempotencyKey) {
    return next();
  }
  
  // Check if we've seen this key before
  const cachedResponse = idempotencyStore.get(idempotencyKey);
  if (cachedResponse) {
    // If the request is still being processed, wait for it
    if (cachedResponse.status === 'processing') {
      return new Promise(resolve => {
        const checkStatus = () => {
          const current = idempotencyStore.get(idempotencyKey);
          if (current.status !== 'processing') {
            res.status(current.statusCode).json(current.body);
            resolve();
          } else {
            setTimeout(checkStatus, 100);
          }
        };
        checkStatus();
      });
    }
    
    // Return cached response
    return res.status(cachedResponse.statusCode).json(cachedResponse.body);
  }
  
  // Mark as processing
  idempotencyStore.set(idempotencyKey, { status: 'processing' });
  
  // Add response handler to cache the response
  const originalJson = res.json;
  res.json = function(body) {
    idempotencyStore.set(idempotencyKey, {
      status: 'completed',
      statusCode: res.statusCode,
      body: body
    });
    originalJson.call(this, body);
  };
  
  next();
};

// Validation middleware for create/update operations
const validateComment = (req, res, next) => {
  const { comment } = req.body;
  
  if (typeof comment !== 'string' || comment.trim() === '') {
    const error = new Error('Comment is required and must be a non-empty string');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return next(error);
  }
  
  // Sanitize input
  req.body.comment = comment.trim();
  next();
};

// CREATE - Add a new comment
router.post(
  "/create",
  (req, res, next) => {
    req.logAction = "create_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  validateComment,
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    
    const { comment, author } = req.body;
    
    // Create context for create operation
    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'createComment',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.body || {}),
      bodySize: req.body ? JSON.stringify(req.body).length : 0,
      commentLength: comment ? comment.length : 0,
      hasAuthor: !!author
    });
    
    logger.debugWithContext("Processing create comment request", baseContext);
    
    if (!comment) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.warnWithContext("Create comment validation failed", {
        ...baseContext,
        validationError: 'Missing comment field',
        duration,
        routeDuration
      });
      
      return res.status(400).json({
        error: "Comment is required",
        requestId
      });
    }
    
    try {
      const result = await db.run(
        "INSERT INTO comments (comment, author) VALUES (?, ?)",
        [comment, author || null]
      );
      
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.infoWithContext(
        "Comment created successfully", 
        {
          ...baseContext,
          status: "success",
          commentId: result.lastID,
          duration,
          routeDuration
        }
      );
      
      // Add metric for successful operation
      logger.metric('cruda_operations', duration, {
        operation: 'createComment',
        result: 'success'
      });
      
      // Send webhook and pass the request object
      const webhookPayload = { id: result.lastID, comment, author };
      const webhookResult = await logAndSendWebhook({
        event: "comment_created",
        data: webhookPayload
      }, req);
      
      const response = { 
        id: result.lastID, 
        comment, 
        author,
        requestId 
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
            ...baseContext,
            tokenAdded: true
          }
        );
      }
      
      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logErrorWithMetrics(
        "Error creating comment",
        {
          ...baseContext,
          duration,
          routeDuration
        },
        error,
        'cruda_error',
        {
          operation: 'createComment',
          result: 'error',
          duration
        }
      );
      
      res.status(500).json({ 
        error: "Internal server error",
        requestId
      });
    }
  }
);

// READ - Read all comments (POST version)
router.post(
  "/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    
    // Create context for list operation
    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'listComments',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.body || {}),
      bodySize: req.body ? JSON.stringify(req.body).length : 0
    });
    
    logger.debugWithContext("Processing list comments request", baseContext);
    
    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;
      
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.infoWithContext(
        "Comments retrieved successfully", 
        {
          ...baseContext,
          status: "success",
          count: itemCount,
          duration,
          routeDuration
        }
      );
      
      // Add metric for successful operation
      logger.metric('cruda_operations', duration, {
        operation: 'listComments',
        result: 'success',
        count: itemCount
      });
      
      // Send webhook and pass the request object
      const webhookPayload = { count: itemCount };
      const webhookResult = await logAndSendWebhook({
        event: "comments_listed",
        data: webhookPayload
      }, req);
      
      const response = { 
        comments,
        requestId 
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
            ...baseContext,
            tokenAdded: true
          }
        );
      }
      
      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logErrorWithMetrics(
        "Error retrieving comments",
        {
          ...baseContext,
          duration,
          routeDuration
        },
        error,
        'cruda_error',
        {
          operation: 'listComments',
          result: 'error',
          duration
        }
      );
      
      res.status(500).json({ 
        error: "Internal server error",
        requestId 
      });
    }
  }
);

// READ - Read all comments (GET version for test compatibility)
router.get(
  "/list",
  (req, res, next) => {
    req.logAction = "read_all_items";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    
    // Create context for list operation
    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'listComments',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.body || {}),
      bodySize: req.body ? JSON.stringify(req.body).length : 0
    });
    
    logger.debugWithContext("Processing GET list comments request", baseContext);
    
    try {
      const comments = await db.all("SELECT * FROM comments");
      const itemCount = comments.length;
      
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logger.infoWithContext(
        "Comments retrieved successfully via GET", 
        {
          ...baseContext,
          status: "success",
          count: itemCount,
          duration,
          routeDuration
        }
      );
      
      // Add metric for successful operation
      logger.metric('cruda_operations', duration, {
        operation: 'listComments',
        result: 'success',
        count: itemCount,
        method: 'GET'
      });
      
      const response = { 
        comments,
        requestId 
      };
      
      res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      
      logErrorWithMetrics(
        "Error retrieving comments via GET",
        {
          ...baseContext,
          duration,
          routeDuration
        },
        error,
        'cruda_error',
        {
          operation: 'listComments',
          result: 'error',
          duration,
          method: 'GET'
        }
      );
      
      res.status(500).json({ 
        error: "Internal server error",
        requestId 
      });
    }
  }
);

// READ - Read a specific comment by id (POST version)
router.post(
  "/read",
  (req, res, next) => {
    req.logAction = "read_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();

    const { id } = req.body || {};

    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'readComment',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.body || {}),
      itemId: id
    });

    logger.debugWithContext("Processing read comment request", baseContext);

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("Read comment validation failed - missing id", { ...baseContext, duration, routeDuration });
      return res.status(400).json({ error: "ID is required", requestId });
    }

    try {
      const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      if (!comment) {
        logger.warnWithContext("Comment not found for read", { ...baseContext, duration, routeDuration });
        return res.status(404).json({ error: "Comment not found", requestId });
      }

      logger.infoWithContext("Comment retrieved successfully", { ...baseContext, status: 'success', duration, routeDuration });

      logger.metric('cruda_operations', duration, {
        operation: 'readComment',
        result: 'success'
      });

      return res.json({ comment, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logErrorWithMetrics(
        "Error reading comment",
        { ...baseContext, duration, routeDuration },
        error,
        'cruda_error',
        { operation: 'readComment', result: 'error', duration }
      );
      return res.status(500).json({ error: "Internal server error", requestId });
    }
  }
);

// READ - Read by id (GET version for compatibility)
router.get(
  "/read/:id",
  (req, res, next) => {
    req.logAction = "read_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const id = req.params.id;

    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'readCommentGET',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      itemId: id
    });

    logger.debugWithContext("Processing GET read comment request", baseContext);

    try {
      const comment = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      if (!comment) {
        logger.warnWithContext("Comment not found for GET read", { ...baseContext, duration, routeDuration });
        return res.status(404).json({ error: "Comment not found", requestId });
      }

      logger.infoWithContext("Comment retrieved successfully via GET", { ...baseContext, status: 'success', duration, routeDuration });
      logger.metric('cruda_operations', duration, { operation: 'readComment', result: 'success', method: 'GET' });
      return res.json({ comment, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logErrorWithMetrics(
        "Error reading comment via GET",
        { ...baseContext, duration, routeDuration },
        error,
        'cruda_error',
        { operation: 'readComment', result: 'error', duration, method: 'GET' }
      );
      return res.status(500).json({ error: "Internal server error", requestId });
    }
  }
);

// UPDATE - Update a comment's text
router.post(
  "/update",
  itemExists,
  (req, res, next) => {
    req.logAction = "update_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id, comment } = req.body || {};

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      if (!existing) {
        return res.status(404).json({ error: "Comment not found", requestId });
      }

      await db.run(
        "UPDATE comments SET comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [comment, id]
      );

      const updated = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;

      logger.infoWithContext("Comment updated successfully", { ...baseContext, status: 'success', duration, routeDuration });
      logger.metric('cruda_operations', duration, { operation: 'updateComment', result: 'success' });

      return res.json({ comment: updated, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logErrorWithMetrics(
        "Error updating comment",
        { ...baseContext, duration, routeDuration },
        error,
        'cruda_error',
        { operation: 'updateComment', result: 'error', duration }
      );
      return res.status(500).json({ error: "Internal server error", requestId });
    }
  }
);

// DESTROY - Delete a comment by id
router.post(
  "/destroy",
  itemExists,
  (req, res, next) => {
    req.logAction = "delete_item";
    req.requestId = req.headers['x-request-id'] || ulid();
    req.startTime = Date.now();
    next();
  },
  handleIdempotency,
  async (req, res) => {
    const requestId = req.requestId;
    const startTime = req.startTime || Date.now();
    const routeStartTime = Date.now();
    const { id } = req.body || {};
    const baseContext = createLogContext({
      requestId,
      component: 'CRUDARouter',
      method: 'deleteComment',
      endpoint: req.path,
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      action: req.logAction,
      headers: Object.keys(req.headers),
      bodyKeys: Object.keys(req.body || {}),
      itemId: id
    });

    logger.debugWithContext("Processing delete comment request", baseContext);

    if (!id) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.warnWithContext("Delete validation failed - missing id", { ...baseContext, duration, routeDuration });
      return res.status(400).json({ error: "ID is required", requestId });
    }

    try {
      const existing = await db.get("SELECT * FROM comments WHERE id = ?", [id]);
      if (!existing) {
        return res.status(404).json({ error: "Comment not found", requestId });
      }

      await db.run("DELETE FROM comments WHERE id = ?", [id]);

      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logger.infoWithContext("Comment deleted successfully", { ...baseContext, status: 'success', duration, routeDuration });
      logger.metric('cruda_operations', duration, { operation: 'deleteComment', result: 'success' });

      return res.json({ success: true, id, requestId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const routeDuration = Date.now() - routeStartTime;
      logErrorWithMetrics(
        "Error deleting comment",
        { ...baseContext, duration, routeDuration },
        error,
        'cruda_error',
        { operation: 'deleteComment', result: 'error', duration }
      );
      return res.status(500).json({ error: "Internal server error", requestId });
    }
  }
);

// GET route for CRUDA endpoint info and health check
router.get("/", (req, res) => {
  const requestId = req.headers['x-request-id'] || ulid();
  
  logger.info("CRUDA endpoint info requested", {
    component: 'CRUDARoutes',
    method: 'getInfo',
    requestId,
    ip: req.ip
  });
  
  res.json({
    message: "CRUDA API - Create, Read, Update, Delete operations",
    endpoints: {
      "POST /create": "Create a new comment",
      "POST /list": "List all comments", 
      "GET /list": "List all comments (GET version)",
      "POST /read": "Read a specific comment",
      "POST /update": "Update a comment",
      "POST /destroy": "Delete a comment"
    },
    requestId
  });
});

// Export the database getter
router.getDatabase = getDatabase;

module.exports = router;
