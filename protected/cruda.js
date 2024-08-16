const express = require("express");
const router = express.Router();
const logger = require("../config/logger");
const config = require("config");

const {
  set_rodit_config,
  get_rodit_config,
  send_webhook,
} = require("../middleware/rodit");

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
    logger.error(
      `Error 112: initializing Rodit configuration: ${error.message}`
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
  logEvent(event, data, isError);
  await send_webhook(event, data, isError);
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
    logAndSendWebhook("comment_not_found", { id, error: errorMessage }, true);
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
    const { title, content } = req.body;
    if (!title || !content) {
      const errorMessage = "Invalid create request: missing title or content";
      logAndSendWebhook("create_comment_error", { error: errorMessage }, true);
      return res.status(400).json({ error: errorMessage });
    }
    const newItem = {
      id: comments.length + 1,
      title,
      content,
    };
    comments.push(newItem);
    logAndSendWebhook("comment_created", {
      id: newItem.id,
      title: newItem.title,
      content: newItem.content,
    });
    const response = { ...newItem };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
    }
    res.status(201).json(response);
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
    logAndSendWebhook("comments_listed", { count: itemCount });
    const response = { comments };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
    }
    res.json(response);
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
    logAndSendWebhook("comment_read", {
      id: req.comment.id,
      title: req.comment.title,
      content: req.comment.content,
    });
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
  (req, res) => {
    const { title, content } = req.body;
    const oldComment = { ...req.comment };
    if (title) req.comment.title = title;
    if (content) req.comment.content = content;
    logAndSendWebhook("comment_updated", {
      id: req.comment.id,
      oldTitle: oldComment.title,
      newTitle: req.comment.title,
      oldContent: oldComment.content,
      newContent: req.comment.content,
    });
    const response = { ...req.comment };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
    }
    res.json(response);
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
    logAndSendWebhook("comment_destroyed", {
      id: deletedComment.id,
      title: deletedComment.title,
      content: deletedComment.content,
    });
    const response = {
      message: "Comment successfully deleted",
      deletedComment: {
        id: deletedComment.id,
        title: deletedComment.title,
        content: deletedComment.content,
      },
    };
    if (req.new_jwt_token) {
      response.new_jwt_token = req.new_jwt_token;
    }
    res.status(200).json(response);
  }
);

module.exports = router;
