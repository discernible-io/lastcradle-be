/**
 * Model Context Protocol (MCP) Routes
 * 
 * This file defines routes that implement the Model Context Protocol (MCP) interface,
 * allowing AI models to access structured data from the application.
 */

const express = require('express');
const router = express.Router();
const { authenticate_apicall } = require('../middleware/authenticationmw');
const mcpService = require('../services/mcpservice');
const logger = require('../../config/logger');

/**
 * @swagger
 * /api/mcp/resources:
 *   get:
 *     summary: List available MCP resources
 *     description: Returns a list of resources available through the MCP interface
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available resources
 *       401:
 *         description: Unauthorized
 */
router.get('/resources', async (req, res) => {
  try {
    const resources = await mcpService.listAvailableResources(req);
    
    res.json({
      resources,
      cursor: null // No pagination implemented yet
    });
  } catch (error) {
    logger.errorWithContext('Error listing MCP resources', {
      component: 'MCPRoutes',
      method: 'GET /resources'
    }, error);
    
    res.status(500).json({
      error: 'Failed to list resources',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/mcp/resource/{uri}:
 *   get:
 *     summary: Get a specific MCP resource
 *     description: Returns the content of a specific resource
 *     tags: [MCP]
 *     parameters:
 *       - in: path
 *         name: uri
 *         schema:
 *           type: string
 *         required: true
 *         description: URI of the resource to retrieve
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Resource content
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Resource not found
 */
router.get('/resource/:uri(*)', authenticate_apicall, async (req, res) => {
  try {
    const uri = req.params.uri;
    const resource = await mcpService.getResource(uri, req);
    
    if (!resource) {
      return res.status(404).json({
        error: 'Resource not found',
        uri
      });
    }
    
    res.json(resource);
  } catch (error) {
    logger.errorWithContext('Error retrieving MCP resource', {
      component: 'MCPRoutes',
      method: 'GET /resource/:uri',
      uri: req.params.uri
    }, error);
    
    if (error.message.includes('Unauthorized')) {
      return res.status(401).json({
        error: 'Unauthorized access to resource',
        message: error.message
      });
    }
    
    if (error.message.includes('Unknown') || error.message.includes('not found')) {
      return res.status(404).json({
        error: 'Resource not found',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Failed to retrieve resource',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/mcp/schema:
 *   get:
 *     summary: Get MCP schema
 *     description: Returns the schema for the MCP interface
 *     tags: [MCP]
 *     responses:
 *       200:
 *         description: MCP schema
 */
router.get('/schema', (req, res) => {
  res.json({
    name: 'RODiT API MCP Interface',
    version: '1.0.0',
    description: 'Model Context Protocol interface for the RODiT API',
    endpoints: [
      {
        path: '/api/mcp/resources',
        method: 'GET',
        description: 'List available resources',
        requiresAuth: false
      },
      {
        path: '/api/mcp/resource/{uri}',
        method: 'GET',
        description: 'Get a specific resource by URI',
        requiresAuth: true
      },
      {
        path: '/api/mcp/schema',
        method: 'GET',
        description: 'Get MCP schema',
        requiresAuth: false
      }
    ]
  });
});

module.exports = router;
