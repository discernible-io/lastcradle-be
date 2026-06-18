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
