/**
 * Model Context Protocol (MCP) Service
 * 
 * This service implements the Model Context Protocol (MCP) interface for the API,
 * allowing AI models to access structured data from the application.
 */

const logger = require("./logger");
const stateManager = require("../sdk/lib/blockchain/statemanager");
const roditManager = require("../sdk/lib/auth/roditmanager");
const { unixTimeToDateString } = require("../sdk/utils");

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
  try {
    // Get user permissions from request if authenticated
    const userPermissions = req.user?.permissions || [];
    
    // Basic resources available to all authenticated users
    const allResources = [
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
      }
    ];
    
    // Add RODiT-specific resources if user has appropriate permissions
    if (userPermissions.includes("read:rodit") || req.user?.isAdmin) {
      allResources.push({
        name: "rodit_info",
        description: "Information about the service RODiT",
        uri: "rodit/info",
        requiresAuth: true
      });
    }
    
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
    return {
      resources,
      pagination: {
        total: allResources.length,
        returned: resources.length,
        hasMore: endIndex < allResources.length,
        nextCursor
      }
    };
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
      
      case 'subscriptions':
        return getSubscriptionResource(uriParts[1], req);
      
      case 'near':
        return getNearProtocolResource(uriParts[1], req);
      
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
  // Return a comprehensive API schema that includes MCP endpoints
  return {
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
    ],
    availableResources: [
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
    standardApiEndpoints: [
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

/**
 * Gets subscription-related resources
 * @param {string} resourceId - Specific subscription resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - Subscription resource data
 */
async function getSubscriptionResource(resourceId, req) {
  switch (resourceId) {
    case 'info':
      return {
        title: "RODiT API Subscription Information",
        description: "Information about available subscription plans for the RODiT API",
        subscriptionPlans: [
          {
            name: "Basic",
            price: "$49/month",
            features: [
              "Up to 1,000 API calls per day",
              "Basic RODiT token management",
              "Standard support"
            ],
            purchaseInstructions: [
              "Visit https://cableguard.io/pricing to select a plan",
              "Complete the registration process",
              "Receive your API credentials via email"
            ]
          },
          {
            name: "Professional",
            price: "$199/month",
            features: [
              "Up to 10,000 API calls per day",
              "Advanced RODiT token management",
              "Priority support",
              "Access to beta features"
            ],
            purchaseInstructions: [
              "Visit https://cableguard.io/pricing to select a plan",
              "Complete the registration process",
              "Schedule an onboarding call with our team",
              "Receive your API credentials and documentation"
            ]
          },
          {
            name: "Enterprise",
            price: "Custom pricing",
            features: [
              "Unlimited API calls",
              "Full RODiT token ecosystem access",
              "Dedicated support representative",
              "Custom integration assistance",
              "SLA guarantees"
            ],
            purchaseInstructions: [
              "Contact our sales team at sales@cableguard.io",
              "Schedule a consultation to discuss your requirements",
              "Receive a custom quote and implementation plan"
            ]
          }
        ],
        paymentMethods: [
          "Credit/Debit Card",
          "PayPal",
          "Invoice (Enterprise only)",
          "Cryptocurrency (NEAR, ETH, BTC)"
        ],
        contactInformation: {
          sales: "sales@cableguard.io",
          support: "support@cableguard.io",
          phone: "+1-555-CABLEGUARD"
        }
      };
    
    default:
      throw new Error(`Unknown subscription resource: ${resourceId}`);
  }
}

/**
 * Gets NEAR Protocol-related resources
 * @param {string} resourceId - Specific NEAR Protocol resource ID
 * @param {Object} req - Express request object
 * @returns {Object} - NEAR Protocol resource data
 */
async function getNearProtocolResource(resourceId, req) {
  switch (resourceId) {
    case 'guide':
      return {
        title: "NEAR Protocol Address Generation Guide",
        description: "Information about creating and using NEAR Protocol addresses with the RODiT API",
        whatIsNear: {
          description: "NEAR Protocol is a layer-1 blockchain focused on developer and user accessibility. It uses a sharded architecture to achieve scalability.",
          officialWebsite: "https://near.org",
          documentation: "https://docs.near.org"
        },
        addressGeneration: {
          methods: [
            {
              name: "NEAR Wallet",
              description: "The official NEAR wallet is the easiest way to create an account",
              steps: [
                "Visit https://wallet.near.org",
                "Click 'Create Account'",
                "Follow the on-screen instructions to secure your account",
                "Fund your account with NEAR tokens"
              ],
              url: "https://wallet.near.org"
            },
            {
              name: "NEAR CLI",
              description: "Command-line interface for developers",
              steps: [
                "Install NEAR CLI: npm install -g near-cli",
                "Generate a key pair: near generate-key <accountId>",
                "Create account: near create-account <accountId> --masterAccount <fundingAccount> --initialBalance <amount>"
              ],
              documentation: "https://docs.near.org/tools/near-cli"
            },
            {
              name: "Programmatic Generation",
              description: "Generate addresses programmatically using the NEAR API JS library",
              codeExample: `const nearAPI = require('near-api-js');
const { KeyPair } = nearAPI;

// Generate a new key pair
const keyPair = KeyPair.fromRandom('ed25519');
const publicKey = keyPair.getPublicKey().toString();
const privateKey = keyPair.toString();

console.log('Public Key:', publicKey);
console.log('Private Key:', privateKey);`,
              documentation: "https://docs.near.org/api/javascript-library"
            }
          ],
          bestPractices: [
            "Always back up your private keys in a secure location",
            "Use hardware wallets for large amounts",
            "Never share your seed phrase or private keys",
            "Consider using multi-signature accounts for additional security"
          ]
        },
        usingWithRoditApi: {
          description: "To use your NEAR address with the RODiT API, you'll need to:",
          steps: [
            "Register your NEAR account in the RODiT dashboard",
            "Link your NEAR account to your RODiT token",
            "Verify ownership through a blockchain transaction",
            "Access your RODiT token using your NEAR credentials"
          ],
          documentation: "https://docs.cableguard.io/near-integration"
        },
        testnetVsMainnet: {
          description: "NEAR Protocol offers both testnet and mainnet environments",
          testnet: {
            purpose: "Development and testing",
            faucet: "https://wallet.testnet.near.org",
            explorer: "https://explorer.testnet.near.org"
          },
          mainnet: {
            purpose: "Production use",
            explorer: "https://explorer.near.org"
          },
          recommendation: "Always test your integration on testnet before moving to mainnet"
        }
      };
    
    default:
      throw new Error(`Unknown NEAR Protocol resource: ${resourceId}`);
  }
}

module.exports = {
  listAvailableResources,
  getResource,
  getSchemaResource
};
