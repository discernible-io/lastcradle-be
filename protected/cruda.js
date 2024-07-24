const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const loggingmiddleware = require('../middleware/loggingmiddleware');

// Use the logging middleware for all routes
router.use(loggingmiddleware);
// In-memory storage for items
let items = [];

// Middleware to check if the item exists
const itemExists = (req, res, next) => {
  const id = parseInt(req.body.id);
  const item = items.find(item => item.id === id);
  if (!item) {
    logger.warn(`Item not found: ${id}`);
    return res.status(404).json({ error: 'Item not found' });
  }
  req.item = item;
  next();
};

// CREATE - Add a new item
router.post('/cruda/create', (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) {
    logger.warn('Invalid create request: missing name or description');
    return res.status(400).json({ error: 'Name and description are required' });
  }
  const newItem = {
    id: items.length + 1,
    name,
    description
  };
  items.push(newItem);
  logger.info(`Item created: ${newItem.id}`);
  res.status(201).json(newItem);
});

// READ - Get all items
router.post('/cruda/list', (req, res) => {
  logger.info(`List of items read: ${items}`);
  res.json(items);
});

// READ - Get a specific item
router.post('/cruda/get', itemExists, (req, res) => {
  logger.info(`Specific iteam read: ${req.item}`);
  res.json(req.item);
});

// UPDATE - Update an item
router.post('/cruda/update', itemExists, (req, res) => {
  const { name, description } = req.body;
  if (name) req.item.name = name;
  if (description) req.item.description = description;
  logger.info(`Item updated: ${req.item}`);
  res.json(req.item);
});

// DELETE - Delete an item
router.post('/cruda/delete', itemExists, (req, res) => {
  logger.info(`Item deleted: ${req.item.id}`);
  const index = items.findIndex(item => item.id === req.item.id);
  items.splice(index, 1);
  res.status(204).send();
});

module.exports = router;