const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger } = require("@rodit/rodit-auth-be");
const { version: APP_VERSION } = require("../lib/app-version");

/**
 * @route GET /
 * @desc API discovery with agent login guidance (OpenClaw / shell agents)
 */
router.get("/", (req, res) => {
  const requestId = req.requestId || ulid();

  logger.infoWithContext("API root discovery requested", {
    component: "DiscoveryRoutes",
    requestId,
    endpoint: "/",
    ip: req.ip
  });

  return res.status(200).json({
    name: "RODiT Authentication API",
    version: APP_VERSION,
    description:
      "Reference test API for Discernible / RODiT authentication. Agents: start with doc:skills or guide:troubleshooting via MCP HTTP paths (see agentGuide).",
    agentGuide: {
      summary:
        "JWT login for OpenClaw and shell agents: GET /api/login/timestamp → sign locally → POST /api/login → Bearer JWT on protected routes.",
      loginFlow: {
        timestamp: "GET /api/login/timestamp",
        login: "POST /api/login",
        verify: "GET /api/token/claims (or any protected route)"
      },
      discovery: {
        resourceUri: "doc:discovery",
        http: "/api/mcp/resource/doc:discovery"
      },
      skills: {
        resourceUris: ["doc:skills", "skills:skills"],
        http: "/api/mcp/resource/doc:skills"
      },
      gameSkill: {
        markdown: "/api/game/skill.md",
        alias: "/skill.md"
      },
      troubleshooting: {
        resourceUri: "guide:troubleshooting",
        http: "/api/mcp/resource/guide:troubleshooting"
      },
      clawHub: {
        skill: "openclaw skills install clawhub:identyclaw",
        plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin"
      },
      mcpDiscovery: "/.well-known/mcp",
      listResources: "/api/mcp/resources"
    },
    documentation: {
      swagger: "/api-docs/swagger.json",
      openapi: "/api-docs/swagger.json"
    },
    endpoints: {
      public: [
        "/health",
        "/api/login/timestamp",
        "/api/login",
        "/api/mcp/resources",
        "/api/mcp/resource/{uri}",
        "/api/mcp/schema",
        "/.well-known/mcp"
      ],
      authenticated: [
        "/api/logout",
        "/api/cruda",
        "/api/game",
        "/api/token/claims",
        "/api/sessions"
      ]
    },
    endpointsList: [
      "/health",
      "/api/login/timestamp",
      "/api/login",
      "/api/logout",
      "/api/mcp/resources",
      "/api/mcp/resource/{uri}",
      "/api/cruda",
      "/api/game",
      "/api/sessions",
      "/.well-known/mcp"
    ],
    mcp: {
      resources: "/api/mcp/resources",
      schema: "/api/mcp/schema",
      discovery: "/.well-known/mcp",
      tools: ["list_resources", "get_resource"],
      httpAccessForAgents: {
        discovery: "/.well-known/mcp",
        list: "/api/mcp/resources",
        getByUri: "/api/mcp/resource/{uri}",
        skills: "/api/mcp/resource/doc:skills",
        troubleshooting: "/api/mcp/resource/guide:troubleshooting",
        loginGuide: "/api/mcp/resource/guide:agent-login"
      },
      note:
        "MCP doc resources are public (no JWT). Fetch guide:troubleshooting before debugging login. Store jwt_token outside model-visible output (OpenClaw plugin or local file)."
    },
    requestId,
    timestamp: new Date().toISOString()
  });
});

/**
 * @route GET /.well-known/mcp
 * @desc MCP discovery metadata for agents and clients
 */
router.get("/.well-known/mcp", (req, res) => {
  const requestId = req.requestId || ulid();

  logger.infoWithContext("MCP discovery requested", {
    component: "DiscoveryRoutes",
    requestId,
    endpoint: "/.well-known/mcp",
    ip: req.ip
  });

  const host = req.get("host");
  const protocol = req.protocol || "https";
  const baseUrl = host ? `${protocol}://${host}` : null;

  return res.status(200).json({
    title: "syntheticslastcradle MCP Discovery",
    transport: {
      protocol: "streamable-http",
      endpoint: "/mcp",
      absoluteEndpoint: baseUrl ? `${baseUrl}/mcp` : null
    },
    resources: {
      list: "/api/mcp/resources",
      getByUri: "/api/mcp/resource/{uri}",
      examples: [
        "/api/mcp/resource/doc:discovery",
        "/api/mcp/resource/doc:skills",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting",
        "/api/mcp/resource/openapi:swagger"
      ]
    },
    tools: [
      { name: "list_resources", description: "Lists available MCP resources" },
      { name: "get_resource", description: "Retrieves a resource by URI" }
    ],
    agentGuide: {
      summary:
        "Fetch doc:skills or guide:agent-login for JWT login (timestamp challenge → sign → POST /api/login).",
      login: {
        timestamp: "/api/login/timestamp",
        exchange: "/api/login"
      },
      clawHub: {
        skill: "openclaw skills install clawhub:identyclaw",
        plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin"
      }
    },
    httpAccessForAgents: {
      discovery: "/.well-known/mcp",
      list: "/api/mcp/resources",
      getByUri: "/api/mcp/resource/{uri}",
      health: "/health",
      skills: "/api/mcp/resource/doc:skills",
      gameSkill: "/api/game/skill.md",
      loginGuide: "/api/mcp/resource/guide:agent-login",
      troubleshooting: "/api/mcp/resource/guide:troubleshooting",
      examples: [
        "/api/mcp/resource/doc:discovery",
        "/api/mcp/resource/doc:skills",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting"
      ]
    },
    transportNote:
      "For curl and shell agents, use httpAccessForAgents paths. JWT login uses GET /api/login/timestamp and POST /api/login (not MCP session headers).",
    requestId,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
