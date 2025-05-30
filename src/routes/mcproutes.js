/**
 * Model Context Protocol (MCP) Routes
 * 
 * This file defines routes that implement the Model Context Protocol (MCP) interface,
 * allowing AI models to access structured data from the application.
 */

const express = require('express');
const router = express.Router();
const { authenticate_apicall } = require('../../sdk/lib/middleware/authenticationmw');
const mcpService = require('../../config/mcpservice');
const logger = require('../../config/logger');

/**
 * @swagger
 * /api/mcp/resources:
 *   get:
 *     summary: List available MCP resources
 *     description: Returns a list of resources available through the MCP interface
 *     tags: [MCP]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum number of resources to return
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for pagination
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available resources with pagination info
 *       401:
 *         description: Unauthorized
 */
router.get('/resources', async (req, res) => {
  try {
    // Extract pagination parameters from query
    const options = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor
    };
    
    // Get resources with pagination
    const result = await mcpService.listAvailableResources(req, options);
    
    res.json(result);
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
router.get('/schema', async (req, res) => {
  try {
    // Reuse the schema resource to avoid duplication
    const schema = await mcpService.getSchemaResource(req);
    res.json(schema);
  } catch (error) {
    logger.errorWithContext('Error retrieving MCP schema', {
      component: 'MCPRoutes',
      method: 'GET /schema'
    }, error);
    
    res.status(500).json({
      error: 'Failed to retrieve schema',
      message: error.message
    });
  }
});

module.exports = router;
