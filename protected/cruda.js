const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const loggingmw = require('../middleware/loggingmw');

// In-memory storage for comments
let comments = [];

// Middleware to check if the comment exists
const itemExists = (req, res, next) => {
  const id = parseInt(req.body.id);
  const comment = comments.find(comment => comment.id === id);
  if (!comment) {
    logger.warn(`Comment not found: ${id}`);
    return res.status(404).json({ error: 'Comment not found' });
  }
  req.comment = comment;
  next();
};

// CREATE - Add a new comment
router.post('/cruda/create', (req, res, next) => {
  req.logAction = 'create_item';
  next();
}, (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) {
    logger.warn('Invalid create request: missing name or description');
    return res.status(400).json({ error: 'Name and description are required' });
  }
  const newItem = {
    id: comments.length + 1,
    name,
    description
  };
  comments.push(newItem);
  logger.info(`Comment created: ${newItem.description}, ${req.user}`);
  res.status(201).json(newItem);
});

// READ - Read all comments
router.post('/cruda/list', (req, res, next) => {
  req.logAction = 'read_all_items';
  next();
}, (req, res) => {
  // Correctly format the log message to include the number of comments
  logger.info(`List of comments read: ${comments.length}`);
  res.json(comments);
});

// READ - Read a specific comment
router.post('/cruda/read', itemExists, (req, res, next) => {
  req.logAction = 'read_item';
  next();
}, (req, res) => {
  logger.info(`Specific comment read: ${req.comment.description}`);
  res.json(req.comment);
});

// UPDATE - Update an comment
router.post('/cruda/update', itemExists, (req, res, next) => {
  req.logAction = 'update_item';
  next();
}, (req, res) => {
  const { name, description } = req.body;
  if (name) req.comment.name = name;
  if (description) req.comment.description = description;
  logger.info(`Comment updated: ${req.comment.description}`);
  res.json(req.comment);
});

// DESTROY - Destroy an comment
router.post('/cruda/destroy', itemExists, (req, res, next) => {
  req.logAction = 'destroy_item';
  next();
}, (req, res) => {
  const index = comments.findIndex(comment => comment.id === req.comment.id);
  comments.splice(index, 1);
  logger.info(`Comment destroyed: ${req.comment.description}`);
  res.status(204).send();
});

module.exports = router;