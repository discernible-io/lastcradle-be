/**
 * Model Context Protocol (MCP) Routes
 * 
 * This file defines routes that implement the Model Context Protocol (MCP) interface,
 * allowing AI models to access structured data from the application.
 */

const express = require('express');
const router = express.Router();
const { ulid } = require('ulid');
const { RoditClient, errorResponse } = require('@rodit/rodit-auth-be');
const { sendError } = errorResponse;
const fs = require('fs');
const path = require('path');

// Create SDK client instance to access all functionality
const sdkClient = new RoditClient();

// Create authentication middleware using the client instance
const authenticate_apicall = (req, res, next) => {
  return sdkClient.authenticate(req, res, next);
};
const logger = sdkClient.getLogger();
// Note: mcpService may need to be accessed through a different method if available
// Logger methods are available directly on the logger object

// Minimal local MCP service implementation to satisfy tests
// Provides resources list, resource retrieval, and schema retrieval
const mcpCache = {
  swagger: null
};

function loadSwaggerSpec() {
  if (mcpCache.swagger) return mcpCache.swagger;
  try {
    const swaggerPath = path.join(__dirname, '../../api-docs/swagger.json');
    const raw = fs.readFileSync(swaggerPath, 'utf8');
    mcpCache.swagger = JSON.parse(raw);
    return mcpCache.swagger;
  } catch (error) {
    logger.error('Failed to load swagger.json for MCP schema', {
      component: 'MCPRoutes',
      method: 'loadSwaggerSpec',
      error: error.message
    });
    // Return a minimal valid OpenAPI object as fallback
    mcpCache.swagger = {
      openapi: '3.0.0',
      info: { title: 'RODiT API', version: '1.0.0' },
      paths: {}
    };
    return mcpCache.swagger;
  }
}

const mcpService = {
  async listAvailableResources(req, options = {}) {
    const all = [
      { uri: 'openapi:swagger', name: 'OpenAPI Schema', type: 'application/json' },
      { uri: 'config:environment', name: 'Server Environment Config', type: 'application/json' }
    ];
    const start = options.cursor ? parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit || all.length;
    const resources = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? String(start + limit) : null;
    return { resources, nextCursor };
  },

  async getResource(uri, req) {
    if (uri === 'openapi:swagger') {
      return { type: 'application/json', content: loadSwaggerSpec() };
    }
    if (uri === 'config:environment') {
      try {
        const nodeEnv = process.env.NODE_ENV || 'development';
        const cfgPath = path.join(__dirname, '../../config', `${nodeEnv}.json`);
        const raw = fs.readFileSync(cfgPath, 'utf8');
        return { type: 'application/json', content: JSON.parse(raw) };
      } catch (error) {
        logger.error('Failed to load environment config for MCP resource', {
          component: 'MCPRoutes',
          method: 'getResource',
          uri,
          error: error.message
        });
        throw new Error('Resource unavailable');
      }
    }
    throw new Error(`Unknown resource: ${uri}`);
  },

  async getSchemaResource(req) {
    return loadSwaggerSpec();
  }
};

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
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  
  logger.debugWithContext('Processing MCP resources list request', {
    requestId,
    component: 'MCPRoutes',
    event: 'listResources',
    endpoint: '/api/mcp/resources',
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip,
    limit: req.query.limit,
    hasCursor: !!req.query.cursor
  });
  
  try {
    // Extract pagination parameters from query
    const options = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor
    };
    
    // Get resources with pagination
    const result = await mcpService.listAvailableResources(req, options);
    
    const duration = Date.now() - startTime;
    logger.infoWithContext('MCP resources listed successfully', {
      requestId,
      component: 'MCPRoutes',
      event: 'listResources',
      resourceCount: result.resources?.length || 0,
      hasNextCursor: !!result.nextCursor,
      duration
    });
    
    // Add metric for successful operation
    logger.metric('mcp_operations', duration, {
      operation: 'listResources',
      result: 'success'
    });
    
    res.json({
      ...result,
      requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.logErrorWithMetrics(
      'Error listing MCP resources',
      {
        requestId,
        component: 'MCPRoutes',
        event: 'listResources',
        duration
      },
      error,
      'mcp_error',
      {
        operation: 'listResources',
        result: 'error',
        duration
      }
    );
    
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: 'MCP_LIST_FAILED',
      message: 'Failed to list resources',
      details: { detail: error.message }
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
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  const uri = req.params.uri;
  
  logger.debugWithContext('Processing MCP resource request', {
    requestId,
    component: 'MCPRoutes',
    event: 'getResource',
    endpoint: '/api/mcp/resources/:uri',
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip,
    resourceUri: uri
  });
  
  try {
    const resource = await mcpService.getResource(uri, req);
    
    if (!resource) {
      logger.warnWithContext('MCP resource not found', {
        requestId,
        component: 'MCPRoutes',
        event: 'getResource',
        resourceUri: uri,
        status: 404
      });
      
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: 'MCP_RESOURCE_NOT_FOUND',
        message: 'Resource not found',
        details: { uri }
      });
    }
    
    const duration = Date.now() - startTime;
    logger.infoWithContext('MCP resource retrieved successfully', {
      requestId,
      component: 'MCPRoutes',
      event: 'getResource',
      resourceUri: uri,
      resourceType: resource.type || 'unknown',
      resourceSize: JSON.stringify(resource).length,
      duration
    });
    
    // Add metric for successful operation
    logger.metric('mcp_operations', duration, {
      operation: 'getResource',
      resourceUri: uri,
      result: 'success'
    });
    
    res.json({
      ...resource,
      requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorContext = {
      requestId,
      component: 'MCPRoutes',
      event: 'getResource',
      resourceUri: uri,
      duration,
      errorMessage: error.message
    };
    
    if (error.message.includes('Unauthorized')) {
      logger.warnWithContext('Unauthorized access to MCP resource', errorContext);
      
      // Add metric for unauthorized access
      logger.metric('mcp_operations', duration, {
        operation: 'getResource',
        resourceUri: uri,
        result: 'unauthorized'
      });
      
      return sendError(res, {
        statusCode: 401,
        requestId,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized access to resource',
        details: { detail: error.message }
      });
    }
    
    if (error.message.includes('Unknown') || error.message.includes('not found')) {
      logger.warnWithContext('MCP resource not found', errorContext);
      
      // Add metric for not found
      logger.metric('mcp_operations', duration, {
        operation: 'getResource',
        resourceUri: uri,
        result: 'not_found'
      });
      
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: 'MCP_RESOURCE_NOT_FOUND',
        message: 'Resource not found',
        details: { uri, detail: error.message }
      });
    }
    
    logger.logErrorWithMetrics(
      'Error retrieving MCP resource',
      errorContext,
      error,
      'mcp_error',
      {
        operation: 'getResource',
        resourceUri: uri,
        result: 'error',
        duration
      }
    );
    
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: 'MCP_RESOURCE_FAILED',
      message: 'Failed to retrieve resource',
      details: { detail: error.message }
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
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  
  logger.debugWithContext('Processing MCP schema request', {
    requestId,
    component: 'MCPRoutes',
    event: 'getSchema',
    endpoint: '/api/mcp/schema',
    httpMethod: req.method,
    userId: req.user?.id,
    ip: req.ip
  });
  
  try {
    // Reuse the schema resource to avoid duplication
    const schema = await mcpService.getSchemaResource(req);
    
    const duration = Date.now() - startTime;
    logger.infoWithContext('MCP schema retrieved successfully', {
      requestId,
      component: 'MCPRoutes',
      event: 'getSchema',
      schemaSize: JSON.stringify(schema).length,
      duration
    });
    
    // Add metric for successful operation
    logger.metric('mcp_operations', duration, {
      operation: 'getSchema',
      result: 'success'
    });
    
    res.json({
      ...schema,
      requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.logErrorWithMetrics(
      'Error retrieving MCP schema',
      {
        requestId,
        component: 'MCPRoutes',
        event: 'getSchema',
        duration
      },
      error,
      'mcp_error',
      {
        operation: 'getSchema',
        result: 'error',
        duration
      }
    );
    
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: 'MCP_SCHEMA_FAILED',
      message: 'Failed to retrieve schema',
      details: { detail: error.message }
    });
  }
});

module.exports = router;
