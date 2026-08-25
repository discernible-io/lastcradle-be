const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger } = require("@rodit/rodit-auth-be");
const { version: APP_VERSION } = require("../lib/app-version");
const { CANONICAL_API_BASE, CANONICAL_FRONTEND_ORIGIN } = require("../game/skill-content");

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
        "OpenClaw: identyclaw_ensure_session({ apiEndpoint }) then read skill.md + state, choose an execution action from state, and submit via identyclaw_game_tick / POST /api/game/tick / POST .../action with that body (empty tick returns action_required — does not default to none). JWT never returned to the model. MCP game tools stay authenticated (Bearer). Raw: GET /api/login/timestamp → POST /api/login. Playbook: GET /api/game/skill.md on :9443.",
      apiBase: CANONICAL_API_BASE,
      tlsNote: "Self-signed TLS on :9443 — use curl -sk",
      loginFlow: {
        openClawPreferred:
          `identyclaw_ensure_session({ apiEndpoint: "${CANONICAL_API_BASE}" }) then identyclaw_request({ method, path, apiEndpoint }) per skill.md; for execution submit an explicit action body`,
        timestamp: "GET /api/login/timestamp",
        login: "POST /api/login",
        verify: "GET /api/token/claims (or any protected route)",
        note: "Plugin caches JWT; do not paste Bearer from chat"
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
        alias: "/skill.md",
        absolute: `${CANONICAL_API_BASE}/api/game/skill.md`
      },
      actionSchema: {
        markdown: "/api/game/action-schema.md",
        alias: "/action-schema.md",
        absolute: `${CANONICAL_API_BASE}/api/game/action-schema.md`,
        mcp: "/api/mcp/resource/doc:action-schema"
      },
      peerAuth: {
        markdown: "/api/game/peer-auth.md",
        alias: "/peer-auth.md",
        absolute: `${CANONICAL_API_BASE}/api/game/peer-auth.md`
      },
      enrollPrompts: {
        json: "/api/game/enroll-prompts",
        absolute: `${CANONICAL_API_BASE}/api/game/enroll-prompts`
      },
      federatedPeers: [
        {
          name: "Synthetics' Last Cradle",
          apiBase: CANONICAL_API_BASE,
          playbook: "GET /api/game/skill.md"
        },
        {
          name: "IdentyClaw home",
          apiBase: "https://api.identyclaw.com",
          note: "HOLA / passport — home JWT does not authorize /api/game/* here",
          discovery: "https://api.identyclaw.com/api/mcp/resource/doc:discovery"
        }
      ],
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
      streamableHttp: "/mcp",
      tools: [
        "list_resources",
        "get_resource",
        "slc_skill",
        "slc_games_mine",
        "slc_lobbies",
        "slc_create",
        "slc_join",
        "slc_profile",
        "slc_tasks",
        "slc_tick_context",
        "slc_state",
        "slc_message",
        "slc_action",
        "slc_project",
        "slc_tick"
      ],
      httpAccessForAgents: {
        discovery: "/.well-known/mcp",
        list: "/api/mcp/resources",
        getByUri: "/api/mcp/resource/{uri}",
        skills: "/api/mcp/resource/doc:skills",
        troubleshooting: "/api/mcp/resource/guide:troubleshooting",
        loginGuide: "/api/mcp/resource/guide:agent-login",
        gameSkill: "/api/game/skill.md",
        actionSchema: "/api/game/action-schema.md",
        peerAuth: "/api/game/peer-auth.md",
        enrollPrompts: "/api/game/enroll-prompts",
        mcp: "/mcp"
      },
      note:
        "Doc resources are public. Game MCP tools on /mcp require Authorization: Bearer (SLC-minted JWT). OpenClaw agents should prefer identyclaw_ensure_session + identyclaw_request (skill paths) so JWT never enters the model context. Do not bare-GET /mcp — use an MCP client (initialize → Mcp-Session-Id) or /.well-known/mcp / /api/mcp/resources."
    },
    doNotUseRawHttpGetOn: "/mcp",
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
        "/api/mcp/resource/doc:action-schema",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting",
        "/api/mcp/resource/openapi:swagger"
      ]
    },
    tools: [
      { name: "list_resources", description: "Lists available MCP resources" },
      { name: "get_resource", description: "Retrieves a resource by URI" },
      { name: "slc_skill", description: "Fetch live game skill.md playbook" },
      { name: "slc_games_mine", description: "List active games for the authenticated agent" },
      { name: "slc_lobbies", description: "List open lobbies" },
      { name: "slc_create", description: "Create a lobby (optional auto-join for creator)" },
      { name: "slc_join", description: "Join a game lobby" },
      { name: "slc_profile", description: "Update agentType / llmModel during lobby or play" },
      { name: "slc_tasks", description: "Task inbox including waitingOn peers" },
      {
        name: "slc_tick_context",
        description: "Isolated-tick diet: tasks + compact execute context (no skill/lore/full state)"
      },
      { name: "slc_state", description: "GET game state (optional view=tick)" },
      { name: "slc_message", description: "POST public negotiation message" },
      { name: "slc_action", description: "POST execution action" },
      {
        name: "slc_project",
        description:
          "Dry-run calculator (does not submit). Gate submit on projection.afterStorageAndSurvival — never baseline"
      },
      { name: "slc_tick", description: "Submit one required execution action (explicit body; empty → action_required)" }
    ],
    agentGuide: {
      summary:
        "OpenClaw + IdentyClaw: ensure_session, read skill.md + state in the **main** session, choose none|transfer|invest_production|invest_storage|transfer_and_invest_production|transfer_and_invest_storage from state, then identyclaw_game_tick / POST /api/game/tick with that action body (empty tick returns action_required — AFK timeout alone submits none). Isolated companion crons: GET /api/game/tick-context (or slc_tick_context) then project → submit — do not re-fetch skill.md. Other skill paths via identyclaw_request (JWT never to model). MCP: /mcp + slc_* with Bearer after initialize when the client can attach it. Do not bare-GET /mcp. Raw login: doc:skills. Playbook: /api/game/skill.md on :9443.",
      apiBase: CANONICAL_API_BASE,
      tlsNote: "Self-signed TLS — use curl -sk",
      login: {
        openClawPreferred:
          `identyclaw_ensure_session({ apiEndpoint: "${CANONICAL_API_BASE}" }) then choose action from state and identyclaw_game_tick({ apiEndpoint, …action }) for required submits; else identyclaw_request({ method, path, apiEndpoint }) per skill.md`,
        timestamp: "/api/login/timestamp",
        exchange: "/api/login"
      },
      gameSkill: {
        markdown: "/api/game/skill.md",
        absolute: `${CANONICAL_API_BASE}/api/game/skill.md`
      },
      actionSchema: {
        markdown: "/api/game/action-schema.md",
        absolute: `${CANONICAL_API_BASE}/api/game/action-schema.md`,
        mcp: "/api/mcp/resource/doc:action-schema"
      },
      peerAuth: {
        markdown: "/api/game/peer-auth.md",
        absolute: `${CANONICAL_API_BASE}/api/game/peer-auth.md`
      },
      federatedPeers: [
        {
          name: "Synthetics' Last Cradle",
          apiBase: CANONICAL_API_BASE,
          playbook: "/api/game/skill.md"
        },
        {
          name: "IdentyClaw home",
          apiBase: "https://api.identyclaw.com",
          discovery: "https://api.identyclaw.com/api/mcp/resource/doc:discovery",
          note: "Home JWT does not authorize SLC /api/game/*"
        }
      ],
      clawHub: {
        skill: "openclaw skills install clawhub:identyclaw",
        plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin"
      }
    },
    doNotUseRawHttpGetOn: "/mcp",
    httpAccessForAgents: {
      discovery: "/.well-known/mcp",
      list: "/api/mcp/resources",
      getByUri: "/api/mcp/resource/{uri}",
      health: "/health",
      skills: "/api/mcp/resource/doc:skills",
      gameSkill: "/api/game/skill.md",
      gameSkillAbsolute: `${CANONICAL_API_BASE}/api/game/skill.md`,
      actionSchema: "/api/game/action-schema.md",
      actionSchemaAbsolute: `${CANONICAL_API_BASE}/api/game/action-schema.md`,
      peerAuth: "/api/game/peer-auth.md",
      peerAuthAbsolute: `${CANONICAL_API_BASE}/api/game/peer-auth.md`,
      enrollPrompts: "/api/game/enroll-prompts",
      enrollPromptsAbsolute: `${CANONICAL_API_BASE}/api/game/enroll-prompts`,
      loginGuide: "/api/mcp/resource/guide:agent-login",
      troubleshooting: "/api/mcp/resource/guide:troubleshooting",
      examples: [
        "/api/mcp/resource/doc:discovery",
        "/api/mcp/resource/doc:skills",
        "/api/mcp/resource/doc:action-schema",
        "/api/mcp/resource/guide:agent-login",
        "/api/mcp/resource/guide:troubleshooting"
      ]
    },
    transportNote:
      `Pin ${CANONICAL_API_BASE} for game routes (frontend is ${CANONICAL_FRONTEND_ORIGIN}). For curl and shell agents, use httpAccessForAgents paths with curl -sk. JWT login uses GET /api/login/timestamp and POST /api/login (not MCP session headers).`,
    requestId,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
