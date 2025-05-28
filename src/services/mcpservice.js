/**
 * Model Context Protocol (MCP) Service
 * 
 * This service implements the Model Context Protocol (MCP) interface for the API,
 * allowing AI models to access structured data from the application.
 */

const logger = require("../../config/logger");
const stateManager = require("../blockchain/statemanager");
const roditManager = require("../auth/roditmanager");

/**
 * Formats RODiT data for MCP consumption
 * @param {Object} rodit - The RODiT object to format
 * @returns {Object} - Formatted RODiT data
 */
function formatRoditForMcp(rodit) {
  if (!rodit) return null;
  
  return {
    token_id: rodit.token_id,
    metadata: rodit.metadata || {},
    status: {
      isActive: rodit.isActive || false,
      isLive: rodit.isLive || false
    }
  };
}

/**
 * Lists available resources that can be accessed through the MCP interface
 * @param {Object} req - Express request object
 * @returns {Array} - List of available resources
 */
async function listAvailableResources(req) {
  try {
    // Get user permissions from request if authenticated
    const userPermissions = req.user?.permissions || [];
    
    // Basic resources available to all authenticated users
    const resources = [
      {
        name: "system_info",
        description: "Basic system information",
        uri: "system/info",
        requiresAuth: true
      },
      {
        name: "api_schema",
        description: "API schema information",
        uri: "schema",
        requiresAuth: false
      }
    ];
    
    // Add RODiT-specific resources if user has appropriate permissions
    if (userPermissions.includes("read:rodit") || req.user?.isAdmin) {
      resources.push({
        name: "rodit_info",
        description: "Information about the service RODiT",
        uri: "rodit/info",
        requiresAuth: true
      });
    }
    
    return resources;
  } catch (error) {
    logger.errorWithContext("Error listing MCP resources", {
      component: "MCPService",
      method: "listAvailableResources"
    }, error);
    
    throw error;
  }
}

/**
 * Retrieves a specific resource by URI
 * @param {string} uri - Resource URI
 * @param {Object} req - Express request object
 * @returns {Object} - Resource data
 */
async function getResource(uri, req) {
  try {
    // Parse URI to determine which resource to fetch
    const uriParts = uri.split('/');
    const resourceType = uriParts[0];
    
    switch (resourceType) {
      case 'system':
        return getSystemResource(uriParts[1], req);
      
      case 'schema':
        return getSchemaResource(req);
      
      case 'rodit':
        // Verify user has permission to access RODiT info
        if (!req.user || (!req.user.permissions?.includes("read:rodit") && !req.user.isAdmin)) {
          throw new Error("Unauthorized access to RODiT resource");
        }
        return getRoditResource(uriParts[1], req);
      
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
  } catch (error) {
    logger.errorWithContext("Error retrieving MCP resource", {
      component: "MCPService",
      method: "getResource",
      uri
    }, error);
    
    throw error;
  }
}

/**
 * Gets system-related resources
 * @param {string} resourceId - Specific system resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - System resource data
 */
async function getSystemResource(resourceId, req) {
  switch (resourceId) {
    case 'info':
      // Basic system info that doesn't expose sensitive details
      return {
        name: "RODiT API Server",
        version: process.env.npm_package_version || "1.0.0",
        environment: process.env.NODE_ENV || "development",
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      };
    
    default:
      throw new Error(`Unknown system resource: ${resourceId}`);
  }
}

/**
 * Gets API schema information
 * @param {Object} req - Express request object
 * @returns {Object} - Schema information
 */
async function getSchemaResource(req) {
  // Return a simplified API schema
  return {
    apiName: "RODiT API",
    version: "1.0.0",
    endpoints: [
      {
        path: "/api/sessions/login",
        method: "POST",
        description: "Authenticate and obtain a JWT token",
        requiresAuth: false
      },
      {
        path: "/api/sessions/logout",
        method: "POST",
        description: "Invalidate the current session",
        requiresAuth: true
      },
      {
        path: "/api/echo",
        method: "POST",
        description: "Echo back the request body",
        requiresAuth: true
      },
      {
        path: "/api/cruda",
        method: "GET",
        description: "CRUD operations with permission validation",
        requiresAuth: true
      }
    ]
  };
}

/**
 * Gets RODiT-related resources
 * @param {string} resourceId - Specific RODiT resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - RODiT resource data
 */
async function getRoditResource(resourceId, req) {
  switch (resourceId) {
    case 'info':
      const configObject = await stateManager.getConfigOwnRodit();
      if (!configObject || !configObject.own_rodit) {
        throw new Error("RODiT configuration not available");
      }
      
      // Format RODiT data for MCP consumption
      return formatRoditForMcp(configObject.own_rodit);
    
    default:
      throw new Error(`Unknown RODiT resource: ${resourceId}`);
  }
}

module.exports = {
  listAvailableResources,
  getResource
};
