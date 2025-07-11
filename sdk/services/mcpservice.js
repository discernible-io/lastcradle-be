/**
 * Model Context Protocol (MCP) Service
 * 
 * This service implements the Model Context Protocol (MCP) interface for the API,
 * allowing AI models to access structured data from the application.
 */

const logger = require("./logger");
const { createLogContext, logErrorWithMetrics } = logger;
const { ulid } = require("ulid");
const stateManager = require("../lib/blockchain/statemanager");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const blockchainService = require("../lib/blockchain/blockchainservice");
const {
  nearorg_rpc_state,
  nearorg_rpc_accesskeys,
  nearorg_rpc_tokenfromroditid,
  nearorg_rpc_rodit_owner,
  nearorg_rpc_listpublicagents,
  nearorg_rpc_getnonce,
  nearorg_rpc_verifysignature
} = blockchainService;


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
 * @param {Object} options - Pagination options
 * @returns {Object} - List of available resources with pagination info
 */
async function listAvailableResources(req, options = {}) {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "listAvailableResources",
    userId: req.user?.id,
    hasPermissions: !!req.user?.permissions,
    options: JSON.stringify(options)
  });
  
  logger.debugWithContext("Listing available MCP resources", baseContext);
  
  try {
    // Get user permissions from request if authenticated
    const userPermissions = req.user?.permissions || [];
    
    // Static resources always available
    let allResources = [
      {
        name: "system_info",
        description: "Basic system information",
        uri: "health/info",
        requiresAuth: true
      },
      {
        name: "api_schema",
        description: "API schema information",
        uri: "schema",
        requiresAuth: false
      },
      {
        name: "subscription_info",
        description: "Information about available subscriptions",
        uri: "subscriptions/info",
        requiresAuth: false
      },
      {
        name: "near_protocol_guide",
        description: "Guide for generating and using NEAR Protocol addresses",
        uri: "near/guide",
        requiresAuth: false
      },
      {
        name: "agents_directory",
        description: "Publicly listed AI agents directory",
        uri: "list_agents",
        requiresAuth: false
      },
      {
        name: "purchase_subscription_guide",
        description: "Guide to purchasing a RODiT ID token and subscription",
        uri: "purchase/guide",
        requiresAuth: false
      },
      {
        name: "rodit_info",
        description: "Information about the service RODiT",
        uri: "rodit/info",
        requiresAuth: true
      },
      {
        name: "mock_ai_agent",
        description: "Deterministic test agent for mutual verification",
        uri: "agent/mock-ai-agent",
        requiresAuth: false
      },
      {
        name: "guides_index_placeholder",
        description: "Placeholder entry to ensure guides folder is scanned (will be replaced below)",
        uri: "guides/index",
        requiresAuth: false
      }
    ];
    
    // Dynamically append public RODiT tokens from blockchain
    try {
      const chainData = await nearorg_rpc_listpublicagents({ limit: 1000, cursor: undefined });
      (chainData.list_agents || []).forEach(a => {
        allResources.push({
          name: `rodit_${a.token_id}`,
          description: `RODiT token ${a.token_id}`,
          uri: `near/rodit/${a.token_id}`,
          requiresAuth: false
        });
      });
    } catch (err) {
      logger.warnWithContext("Failed to append chain resources", { ...baseContext, err: err.message });
    }

    // Dynamically append Markdown guides from /api-docs/guides
    try {
      const guidesDir = path.join(__dirname, "../../api-docs/guides");
      const files = await fs.readdir(guidesDir);
      files.filter(f => f.endsWith('.md')).forEach(file => {
        const baseName = path.basename(file, '.md');
        allResources.push({
          name: `guide_${baseName}`,
          description: `Documentation guide ${baseName}`,
          uri: `guides/${baseName}`,
          requiresAuth: false
        });
      });
    } catch (err) {
      logger.warnWithContext("Failed to scan guides directory", { ...baseContext, err: err.message });
    }

    // Remove placeholder
    allResources = allResources.filter(r => r.name !== "guides_index_placeholder");

    // Implement pagination
    const { limit = 10, cursor } = options;
    let startIndex = 0;
    
    // If cursor is provided, find the starting index
    if (cursor) {
      const cursorIndex = allResources.findIndex(resource => resource.name === cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1; // Start after the cursor
      }
    }
    
    // Get the resources for this page
    const endIndex = Math.min(startIndex + limit, allResources.length);
    const resources = allResources.slice(startIndex, endIndex);
    
    // Determine the next cursor
    const nextCursor = endIndex < allResources.length ? allResources[endIndex - 1].name : null;
    
    // Return resources with pagination info
    const result = {
      list_resources: resources,
      nextCursor,
      pagination: {
        total: allResources.length,
        returned: resources.length,
        hasMore: endIndex < allResources.length,
        nextCursor
      }
    };
    
    const duration = Date.now() - startTime;
    logger.infoWithContext("MCP resources listed successfully", {
      ...baseContext,
      duration,
      resourceCount: resources.length,
      totalResources: allResources.length,
      hasMore: endIndex < allResources.length
    });
    
    // Add metric for successful operation
    logger.metric("mcp_service_operations", duration, {
      operation: "listAvailableResources",
      result: "success"
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error listing MCP resources",
      {
        ...baseContext,
        duration
      },
      error,
      "mcp_service_error",
      {
        operation: "listAvailableResources",
        result: "error",
        duration
      }
    );
    
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
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "getResource",
    uri,
    userId: req.user?.id,
    hasPermissions: !!req.user?.permissions,
    resourceType: uri.split('/')[0]
  });
  
  logger.debugWithContext("Retrieving MCP resource", baseContext);
  
  try {
    // Parse URI to determine which resource to fetch
    const uriParts = uri.split('/');
    const resourceType = uriParts[0];
    
    switch (resourceType) {
      case 'health':
        return getSystemResource(uriParts[1], req);
      
      case 'schema':
        return getSchemaResource(req);
      
      case 'rodit':
        // Verify user has permission to access RODiT info
        if (!req.user || (!req.user.permissions?.includes("read:rodit") && !req.user.isAdmin)) {
          throw new Error("Unauthorized access to RODiT resource");
        }
        return getRoditResource(uriParts[1], req);
      
      case 'subscriptions':
        return getSubscriptionResource(uriParts[1], req);
      
      case 'near':
        return getNearProtocolResource(uriParts.slice(1), req);
      
      case 'list_agents':
        return await getAgentsResource(req);
      case 'agent':
        return await getAgentResource(uriParts[1], req);
      
      case 'guides':
        return getGuideResource(uriParts[1]);
      
      case 'purchase':
        return getPurchaseGuideResource();
      
      default:
        throw new Error(`Unknown resource type: ${resourceType}`);
    }
    
    const duration = Date.now() - startTime;
    logger.infoWithContext("MCP resource retrieved successfully", {
      ...baseContext,
      duration,
      resourceType
    });
    
    // Add metric for successful operation
    logger.metric("mcp_service_operations", duration, {
      operation: "getResource",
      resourceType,
      result: "success"
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error retrieving MCP resource",
      {
        ...baseContext,
        duration
      },
      error,
      "mcp_service_error",
      {
        operation: "getResource",
        result: "error",
        duration
      }
    );
    
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
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "getSystemResource",
    resourceId,
    userId: req.user?.id
  });
  
  logger.debugWithContext("Retrieving system resource", baseContext);
  switch (resourceId) {
    case 'info':
       // Extended system info (non-sensitive)
       const mem = process.memoryUsage();
       return {
         name: "Discernible ID API Server",
         version: process.env.npm_package_version || "1.0.0",
         nodeVersion: process.version,
         environment: process.env.NODE_ENV || "development",
         platform: process.platform,
         arch: process.arch,
         cpus: os.cpus().length,
         uptime: process.uptime(),
         loadAverage: os.loadavg()[0],
         memory: {
           rss: mem.rss,
           heapTotal: mem.heapTotal,
           heapUsed: mem.heapUsed,
           external: mem.external
         },
         timestamp: new Date().toISOString()
       };
    
    default:
      logger.warnWithContext(`Unknown system resource requested: ${resourceId}`, baseContext);
      throw new Error(`Unknown system resource: ${resourceId}`);
  }
  
  const duration = Date.now() - startTime;
  logger.debugWithContext("System resource retrieved successfully", {
    ...baseContext,
    duration
  });
  
  // Add metric for successful operation
  logger.metric("mcp_service_operations", duration, {
    operation: "getSystemResource",
    resourceId,
    result: "success"
  });
}

/**
 * Gets API schema information
 * @param {Object} req - Express request object
 * @returns {Object} - Schema information
 */
async function getSchemaResource(req) {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "getSchemaResource",
    userId: req.user?.id
  });
  
  logger.debugWithContext("Retrieving API schema resource", baseContext);

  // Try to load schema from JSON file first
  try {
    const filePath = path.join(__dirname, "../../api-docs/mcp-schema.json");
    const raw = await fs.readFile(filePath, "utf8");
    const schema = JSON.parse(raw);
    const duration = Date.now() - startTime;
    logger.infoWithContext("API schema resource retrieved successfully", { ...baseContext, duration });
    logger.metric("mcp_service_operations", duration, { operation: "getSchemaResource", result: "success" });
    return schema;
  } catch (readErr) {
    // Fall back to inline schema if file missing or unreadable
    logger.warnWithContext("Failed to read mcp-schema.json, falling back to inline schema", { ...baseContext, error: readErr.message });
  }
  // Return a comprehensive API schema that includes MCP endpoints
  // Dynamically generate standardApiEndpoints from Swagger specification
  let standardApiEndpoints = [];
  let swaggerVersion = '1.0.0';
  try {
    const swaggerPath = path.join(__dirname, "../../api-docs/swagger.json");
    const swaggerRaw = await fs.readFile(swaggerPath, "utf8");
    const swagger = JSON.parse(swaggerRaw);
    swaggerVersion = swagger?.info?.version || swaggerVersion;

    if (swagger.paths) {
      for (const [endpointPath, methods] of Object.entries(swagger.paths)) {
        // Skip MCP endpoints – they are represented separately
        if (endpointPath.startsWith("/api/mcp")) continue;

        for (const [method, details] of Object.entries(methods)) {
          standardApiEndpoints.push({
            path: endpointPath,
            method: method.toUpperCase(),
            description: details.summary || details.description || "",
            requiresAuth: Array.isArray(details.security) && details.security.length > 0
          });
        }
      }
    }
  } catch (swaggerErr) {
    logger.warnWithContext("Failed to generate standardApiEndpoints from swagger.json", { ...baseContext, error: swaggerErr.message });
  }
  try {
    const result = {
      name: 'Discernible ID API MCP Interface',
      version: swaggerVersion,
      description: 'Model Context Protocol interface for the Discernible ID API',
    endpoints: [
      {
        path: '/api/mcp/list_resources',
        method: 'POST',
        description: 'List available resources',
        requiresAuth: false
      },
      {
        path: '/api/mcp/resource/{uri}',
        method: 'POST',
        description: 'Get a specific resource by URI',
        requiresAuth: true
      },
      {
        path: '/api/mcp/schema',
        method: 'POST',
        description: 'Get MCP schema',
        requiresAuth: false
      }
    ],
    availableResources: [
      {
        name: "agents_directory",
        description: "Publicly listed AI agents directory",
        uri: "list_agents",
        requiresAuth: false
      },
      {
        name: "purchase_subscription_guide",
        description: "Guide to purchasing a RODiT ID token and subscription",
        uri: "purchase/guide",
        requiresAuth: false
      },
      {
        name: "system_info",
        description: "Basic system information",
        uri: "health/info",
        requiresAuth: true
      },
      {
        name: "api_schema",
        description: "API schema information",
        uri: "schema",
        requiresAuth: false
      },
      {
        name: "subscription_info",
        description: "Information about available subscriptions",
        uri: "subscriptions/info",
        requiresAuth: false
      },
      {
        name: "near_protocol_guide",
        description: "Guide for generating and using NEAR Protocol addresses",
        uri: "near/guide",
        requiresAuth: false
      },
      {
        name: "rodit_info",
        description: "Information about the service RODiT",
        uri: "rodit/info",
        requiresAuth: true
      }
    ],
    standardApiEndpoints
    };
    
    const duration = Date.now() - startTime;
    logger.infoWithContext("API schema resource retrieved successfully", {
      ...baseContext,
      duration
    });
    
    // Add metric for successful operation
    logger.metric("mcp_service_operations", duration, {
      operation: "getSchemaResource",
      result: "success"
    });
    
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error retrieving API schema resource",
      {
        ...baseContext,
        duration
      },
      error,
      "mcp_service_error",
      {
        operation: "getSchemaResource",
        result: "error",
        duration
      }
    );
    
    throw error;
  }
}

/**
 * Gets RODiT-related resources
 * @param {string} resourceId - Specific RODiT resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - RODiT resource data
 */
async function getRoditResource(resourceId, req) {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "getRoditResource",
    resourceId,
    userId: req.user?.id
  });
  
  logger.debugWithContext("Retrieving RODiT resource", baseContext);
  
  try {
    switch (resourceId) {
    case 'info':
      const configObject = await stateManager.getConfigOwnRodit();
      if (!configObject || !configObject.own_rodit) {
        throw new Error("RODiT configuration not available");
      }
      
      // Format RODiT data for MCP consumption
      const result = formatRoditForMcp(configObject.own_rodit);
      
      const duration = Date.now() - startTime;
      logger.infoWithContext("RODiT resource retrieved successfully", {
        ...baseContext,
        duration,
        tokenId: result?.token_id
      });
      
      // Add metric for successful operation
      logger.metric("mcp_service_operations", duration, {
        operation: "getRoditResource",
        resourceId,
        result: "success"
      });
      
      return result;
    
    default:
      logger.warnWithContext(`Unknown RODiT resource requested: ${resourceId}`, baseContext);
      throw new Error(`Unknown RODiT resource: ${resourceId}`);
  }
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error retrieving RODiT resource",
      {
        ...baseContext,
        duration
      },
      error,
      "mcp_service_error",
      {
        operation: "getRoditResource",
        result: "error",
        duration
      }
    );
    
    throw error;
  }
}

/**
 * Gets subscription-related resources
 * @param {string} resourceId - Specific subscription resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - Subscription resource data
 */
async function getSubscriptionResource(resourceId, req) {
  const requestId = ulid();
  const startTime = Date.now();
  
  const baseContext = createLogContext({
    requestId,
    component: "MCPService",
    method: "getSubscriptionResource",
    resourceId,
    userId: req.user?.id
  });
  
  logger.debugWithContext("Retrieving subscription resource", baseContext);
  
  try {
    switch (resourceId) {
    case 'info':
      const result = {
        title: "Discernible ID Subscription Information",
        description: "Information about available subscription plans for the Discernible ID API",
        subscriptionPlans: [
          {
            name: "Discernible ID",
            price: "Single Payment",
            features: [
              "1000 API calls per hour",
              "Unique facial features",
              "Optional ID owner assertion",
              "AI assisted support",
            ],
            purchaseInstructions: [
              "Contact our sales team at sales@discernible.io",
              "Schedule a consultation to discuss your requirements",
              "Receive a custom quote and implementation plan"
            ]
          }
        ],
        paymentMethods: [
          "Stripe",
          "NEAR Cryptocurrency",
          "Invoice"
        ],
        contactInformation: {
          sales: "sales@discernible.io",
          support: "support@discernible.io"
        }
      };
      
      const duration = Date.now() - startTime;
      logger.infoWithContext("Subscription resource retrieved successfully", {
        ...baseContext,
        duration
      });
      
      // Add metric for successful operation
      logger.metric("mcp_service_operations", duration, {
        operation: "getSubscriptionResource",
        resourceId,
        result: "success"
      });
      
      return result;
    
    default:
      logger.warnWithContext(`Unknown subscription resource requested: ${resourceId}`, baseContext);
      throw new Error(`Unknown subscription resource: ${resourceId}`);
  }
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logErrorWithMetrics(
      "Error retrieving subscription resource",
      {
        ...baseContext,
        duration
      },
      error,
      "mcp_service_error",
      {
        operation: "getSubscriptionResource",
        result: "error",
        duration
      }
    );
    
    throw error;
  }
}

/**
 * Gets NEAR Protocol-related resources
 * @param {string} resourceId - Specific NEAR Protocol resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - NEAR Protocol resource data
 */
async function getNearProtocolResource(resourcePath, req) {
  const parts = Array.isArray(resourcePath) ? resourcePath : resourcePath.split('/');
  const primary = parts[0];
  const requestId = ulid();
  const baseContext = createLogContext({ requestId, component: "MCPService", method: "getNearProtocolResource", resourcePath: parts.join('/') });
  logger.debugWithContext("Retrieving NEAR resource", baseContext);
  try {
    switch (primary) {
      case 'account': {
        const accountId = parts[1];
        const sub = parts[2];
        if (sub === 'state') return await nearorg_rpc_state(accountId);
        if (sub === 'keys') return await nearorg_rpc_accesskeys(accountId);
        break;
      }
      case 'rodit': {
        const tokenId = parts[1];
        const sub = parts[2];
        if (sub === 'owner') return await nearorg_rpc_rodit_owner(tokenId);
        if (sub === 'list') {
          const limit = parts[3] ? parseInt(parts[3], 10) : 20;
          const cursor = parts[4];
          return await nearorg_rpc_listpublicagents({ limit, cursor });
        }
        return await nearorg_rpc_tokenfromroditid(tokenId);
      }
      case 'auth': {
        const action = parts[1];
        const tokenId = parts[2];
        if (action === 'challenge') return await nearorg_rpc_getnonce(tokenId);
        if (action === 'verify') {
          const nonce = parts[3];
          const sig = parts[4];
          return await nearorg_rpc_verifysignature(tokenId, nonce, sig);
        }
        break;
      }
      case 'guide':
        return buildNearProtocolGuide();
      default:
        throw new Error(`Unknown NEAR resource path: ${parts.join('/')}`);
    }
  } catch (err) {
    logErrorWithMetrics("Error fetching NEAR resource", baseContext, err, "mcp_near_error", {});
    throw err;
  }
}

function buildNearProtocolGuide() {
  // Updated to reference latest implicit accounts and CLI RS integration docs (@api-docs/nearimplicitaccounts.md)
  return {
    title: "NEAR Implicit Accounts & CLI RS Integration Guide",
    description:
      "Comprehensive guide for creating and managing NEAR implicit accounts, installing NEAR CLI RS, and securely integrating with the Discernible ID API.",
    links: {
      officialWebsite: "https://near.org",
      documentation: "https://docs.near.org",
      cliRs: "https://github.com/near/near-cli-rs",
      implicitAccountsGuide:
        "https://api.discernible.io/nearimplicitaccounts.md"
    }
  };
}


/**
 * Reads a Markdown guide from api-docs/guides/{name}.md and returns its raw content.
 * @param {string} guideName
 */
async function getGuideResource(guideName) {
  const guidePath = path.join(__dirname, `../../api-docs/guides/${guideName}.md`);
  const exists = await fs
    .access(guidePath)
    .then(() => true)
    .catch(() => false);
  if (!exists) throw new Error("Guide not found");
  const content = await fs.readFile(guidePath, "utf8");
  return {
    resource: `guide_${guideName}`,
    format: "markdown",
    content,
  };
}

module.exports = {
  listAvailableResources,
  getResource,
  getSchemaResource,
  getNearProtocolResource,
  getAgentsResource,
  getPurchaseGuideResource,
  getAgentResource
};
// ------------------ New MCP Resources ------------------
/**
 * Returns a directory of publicly listed AI list_agents.
 * Supports pagination via query params: limit, cursor
 */
async function getAgentsResource(req) {
  const limit = req.query?.limit ? parseInt(req.query.limit, 10) : 20;
  const cursor = req.query?.cursor;
  const data = await nearorg_rpc_listpublicagents({ limit, cursor });
  return {
    resource: "agents_directory",
    ...data,
  };
}

/**
 * Returns guide on purchasing a RODiT token and subscription.
 * Static content for now.
 */
/**
 * Returns deterministic handshake payload for mock AI agent or throws if unknown.
 * @param {string} agentId
 * @returns {Object}
 */
async function getAgentResource(agentId, req) {
  const roditId = req?.body?.rodit_id;
  const clientSig = req?.body?.client_signature;
  if (agentId === 'mock-ai-agent') {
    const payload = {
      uri: 'agent/mock-ai-agent',
      agent_name: 'Mock Test Agent',
      capabilities: ['echo', 'sign', 'verify'],
      handshake: {
        challenge: 'static-base64-challenge',
        expected_response: 'static-base64-signature'
      },
      timestamp: new Date().toISOString()
    };
    // If caller sent proof, verify it
    if (roditId && clientSig) {
      try {
        const verified = await nearorg_rpc_verifysignature(roditId, 'static-base64-challenge', clientSig);
        payload.verification = { rodit_id: roditId, verified };
      } catch (e) {
        payload.verification = { rodit_id: roditId, verified: false, error: e.message };
      }
    }
    return payload;
  }
  throw new Error(`Unknown agent resource: ${agentId}`);
}

function getPurchaseGuideResource() {
  return {
    resource: "purchase_subscription_guide",
    version: "v1.2",
    description: "Guide for purchasing and minting a RODiT identity token via purchase.discernible.io and enabling a subscription.",
    steps: [
      {
        index: 0,
        title: "Purchase and mint RODiT",
        method: "POST",
        endpoint: "https://purchase.discernible.io",
        request_schema: {
          numberofrodit: "number (1-12)",
          expirationDate: "ISO 8601 Date (YYYY-MM-DD)",
          webhookUrl: "string (https URL)",
          userselectedDN: "string (Distinguished Name)",
          maxRequests: "number (0 = unlimited)",
          maxrqWindow: "number (seconds, 0 = unlimited)",
          permissionedRoutes: "string (JSON array)",
          accountId: "string (NEAR account)"
        },
        response_schema: {
          "201": { signUrl: "string", sessionId: "uuid" },
          "400": { error: "Invalid payload" }
        }
      },
      {
        index: 1,
        title: "Confirm payment & signing",
        description: "User opens the provided signUrl in SignPortal and approves the transaction within the allotted validity period (15 min)."
      },
      {
        index: 2,
        title: "Retrieve token",
        description: "After approval, retrieve the minted token_id from the callback or poll the session endpoint.",
        response_schema: {
          "200": { token_id: "string", expires_in: "number" },
          "401": { error: "Session expired" }
        }
      },
      {
        index: 3,
        title: "Authenticate with token",
        description: "Pass the token_id in the Authorization header (Bearer <token_id>) when calling protected API routes.",
        notes: "Token TTL is 24h; refresh before expiry via the /api/refresh_token endpoint."
      },
      {
        index: 4,
        title: "Manage subscription (optional)",
        method: "POST",
        endpoint: "/api/subscriptions",
        description: "Create, upgrade, or cancel subscription packages using the authenticated token."
      }
    ],
    error_codes: {
      "400": "Validation failed",
      "401": "Unauthorized / token expired",
      "409": "Subscription already active"
    },
    related_endpoints: {
      purchase: "https://purchase.discernible.io",
      manage_subscriptions: "/api/subscriptions",
      agents_directory: "/api/list_agents"
    }
  };
}
