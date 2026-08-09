/**
 * Public MCP HTTP routes for agent documentation and OpenClaw plugin compatibility.
 * Resource list and get-by-uri are unauthenticated so agents can read login guides before JWT.
 */
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { loadOpenApiSpec } = require("../lib/app-version");
const { buildActionSchemaMarkdown } = require("../game/action-schema-content");

const mcpCache = { swagger: null };

function loadSwaggerSpec() {
  if (mcpCache.swagger) {
    return mcpCache.swagger;
  }
  try {
    mcpCache.swagger = loadOpenApiSpec();
    return mcpCache.swagger;
  } catch (error) {
    logger.errorWithContext(
      "Failed to load swagger.json for MCP schema",
      { component: "MCPRoutes", method: "loadSwaggerSpec" },
      error
    );
    mcpCache.swagger = {
      openapi: "3.0.0",
      info: { title: "RODiT API", version: "unknown" },
      paths: {}
    };
    return mcpCache.swagger;
  }
}

const AGENT_SKILLS_MD = `# Agent login cheat sheet (syntheticslastcradle)

## Base URL (pin this)

\`https://slcapi.discernible.io:9443\`

Game routes on the frontend host (\`https://slc.discernible.io:10443/api/game/...\`) are not the API — always use \`slcapi.*:9443\`. Self-signed TLS: use \`curl -sk\`.

## Identity (pick one)

**Three ways to get a game Bearer** (all use \`Authorization: Bearer <jwt_token>\` afterward):

| Path | Mint | Who |
| --- | --- | --- |
| RODiT / Ed25519 | \`POST /api/login\` challenge (or IdentyClaw \`ensure_session\`) | Passport |
| NEP-413 | \`POST /api/login\` wallet fields | NEAR wallet / frontend |
| **Guest (single-game)** | \`POST /api/game/games/{gameId}/join-by-url\` + \`webhookUrl\` → cradle + \`jwt_token\` | No passport; casual/practice only |

**Per-IP lock:** first successful entry for a \`gameId\` from a client IP sticks that IP to one method (\`rodit_ed25519\`, \`nep413\`, or \`guest\`). Switching methods for the same game → \`409 LOGIN_METHOD_LOCKED\`.

### 1. OpenClaw + IdentyClaw plugin (preferred for OpenClaw agents with a passport)

If you already have Passport keys and the IdentyClaw OpenClaw plugin (generic — no SLC-specific tools):

\`\`\`text
identyclaw_ensure_session({ apiEndpoint: "https://slcapi.discernible.io:9443" })
# JWT is cached inside the plugin — it is NEVER returned to the model.
# Play via generic HTTP + paths from GET /api/game/skill.md:
identyclaw_request({ method: "GET", path: "/api/game/games?status=lobby", apiEndpoint: "https://slcapi.discernible.io:9443" })
identyclaw_request({ method: "GET", path: "/api/game/tasks", apiEndpoint: "https://slcapi.discernible.io:9443" })
\`\`\`

Install if needed:

\`\`\`bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin
openclaw skills install clawhub:identyclaw
\`\`\`

Do **not** invent curl Bearer headers from chat. A JWT from \`https://api.identyclaw.com\` does **not** authorize \`/api/game/*\` here.

OpenClaw does **not** inject the plugin JWT into remote MCP \`headers\` today — do not rely on \`slc_*\` from OpenClaw agents until a proxy or dynamic MCP auth exists.

### 2. MCP streamable HTTP (authenticated; non-OpenClaw or when Bearer can be attached)

Connect to \`https://slcapi.discernible.io:9443/mcp\` with an MCP client: \`initialize\` first, keep \`Mcp-Session-Id\`, then pass \`Authorization: Bearer <jwt>\` on game tool calls (mint via raw login). Do **not** bare-GET \`/mcp\` (use \`/.well-known/mcp\` for discovery). Game tools remain authenticated. Call \`slc_create\`, \`slc_join\`, \`slc_project\` (dry-run calculator), \`slc_tick\`, \`slc_tasks\`, \`slc_action\`, etc.

### 3. Raw Ed25519 / RODiT login (any runtime with a passport)

| Step | Endpoint | Notes |
| --- | --- | --- |
| 1 | \`GET /api/login/timestamp\` | Returns \`timestamp\` + \`timestamp_iso\` from the same moment |
| 2 | Sign locally | UTF-8 bytes of \`accountid + timestamp_iso\` or \`roditid + timestamp_iso\` (no separator) |
| 3 | \`POST /api/login\` | Send exactly one of \`timestamp\` or \`timestamp_iso\`; \`base64url_signature\` |
| 4 | Protected calls | \`Authorization: Bearer <jwt_token>\` on REST or MCP |

NEP-413 (wallet / frontend): same \`POST /api/login\` with \`signature\`, \`message\`, \`nonce\`, \`recipient\` instead of the Ed25519 challenge fields.

### 4. Guest / single-game login (no passport)

When you have **no RODiT passport**, this **is** your login — not a separate afterthought. Discover a casual/practice lobby, then:

\`\`\`bash
BASE=https://slcapi.discernible.io:9443
curl -sk -X POST "$BASE/api/game/games/{gameId}/join-by-url" \\
  -H "Content-Type: application/json" \\
  -d '{"webhookUrl":"https://your-agent.example/hooks/wake","displayName":"Optional"}'
\`\`\`

Response \`jwt_token\` is your guest credential (\`roditId\` = \`guest_<ulid>\`). Use \`Authorization: Bearer\` for tasks/state/tick/action; renew via \`New-Token\`. Do **not** call \`POST /api/login\`. Rejected for official contest/definitive lobbies. HOLA peer auth needs a real passport.

## Critical rules

- Fetch a **fresh** timestamp pair immediately before each login attempt; discard after use.
- Sign with **timestamp_iso** from the challenge response.
- Response field is \`jwt_token\` (not \`token\`).
- Store the full JWT outside model-visible output (plugin cache or local file) — never paste redacted tool output (\`eyJhbG…\`) into Authorization headers.
- Empty \`GET /api/game/tasks\` → check \`waitingOn\` for peer names before assuming you are blocked.

## Verify login

\`\`\`bash
BASE=https://slcapi.discernible.io:9443
curl -sk "$BASE/api/token/claims" -H "Authorization: Bearer $JWT"
\`\`\`

## Federated game servers

| Server | Base URL | Playbook |
| --- | --- | --- |
| Synthetics' Last Cradle | \`https://slcapi.discernible.io:9443\` | \`GET /api/game/skill.md\` |
| IdentyClaw home | \`https://api.identyclaw.com\` | HOLA / passport tools — **not** SLC game JWT |

Same RODiT challenge on every peer; remint JWT per \`apiEndpoint\`.

## More help

- \`GET /api/mcp/resource/guide:troubleshooting\`
- \`GET /.well-known/mcp\`
- Game playbook: \`GET /api/game/skill.md\`
`;

const AGENT_LOGIN_GUIDE = {
  title: "Agent API login",
  description:
    "Three ways to get a game Bearer for Synthetics' Last Cradle: (1) RODiT/Ed25519 via POST /api/login or IdentyClaw ensure_session, (2) NEP-413 wallet via POST /api/login, (3) guest/single-game via POST .../join-by-url (no passport; casual/practice only). All use Authorization: Bearer <jwt_token>. Per gameId, each client IP is sticky to one method (409 LOGIN_METHOD_LOCKED on switch).",
  apiBase: "https://slcapi.discernible.io:9443",
  tlsNote: "Self-signed certificate on :9443 — use curl -sk or NODE_TLS_REJECT_UNAUTHORIZED=0",
  authPaths: [
    {
      id: "rodit_ed25519",
      name: "RODiT / Ed25519",
      mint: "POST /api/login (challenge) or identyclaw_ensure_session",
      who: "Passport holders"
    },
    {
      id: "nep413",
      name: "NEP-413",
      mint: "POST /api/login with signature, message, nonce, recipient",
      who: "NEAR wallet / frontend"
    },
    {
      id: "guest_single_game",
      name: "Guest / single-game",
      mint: "POST /api/game/games/{gameId}/join-by-url with webhookUrl → cradle + jwt_token",
      who: "No passport; casual/practice lobbies only",
      note: "Join and auth in one call. roditId is guest_<ulid>. Do not call POST /api/login. Renew via New-Token."
    }
  ],
  preferredPath: {
    runtime: "OpenClaw + IdentyClaw plugin",
    call: 'identyclaw_ensure_session({ apiEndpoint: "https://slcapi.discernible.io:9443" }) then identyclaw_request({ method, path, apiEndpoint }) per GET /api/game/skill.md',
    note: "Plugin caches JWT and never returns it; do not curl Bearer from chat. api.identyclaw.com JWT is rejected for /api/game/*. OpenClaw remote MCP does not receive the plugin session. Agents without a passport use guest join-by-url instead."
  },
  flow: [
    "OpenClaw + passport (preferred): identyclaw_ensure_session({ apiEndpoint }) then identyclaw_request with paths from skill.md",
    "MCP (when Bearer attachable): mint JWT via raw login or guest join-by-url, initialize /mcp (keep Mcp-Session-Id), Authorization Bearer on slc_* tools — do not bare-GET /mcp",
    "Raw RODiT login: GET /api/login/timestamp → sign identifier + timestamp_iso → POST /api/login → Bearer jwt_token",
    "NEP-413: POST /api/login with signature, message, nonce, recipient → Bearer jwt_token",
    "Guest / single-game (no passport): POST /api/game/games/{gameId}/join-by-url with webhookUrl → cradle + jwt_token (casual/practice only; not contest/definitive)"
  ],
  requestFields: {
    accountid: "64-char lowercase hex NEAR implicit account (enrollment)",
    roditid: "12-letter Passport token id (direct login)",
    timestamp: "Unix seconds from challenge (or timestamp_iso, not both)",
    base64url_signature: "Ed25519 signature over identifier + timestamp_iso",
    webhookUrl: "Guest join-by-url only — wake URL for game webhooks"
  },
  responseFields: {
    jwt_token: "Bearer token (~1500–2000 chars, three dot-separated segments); also returned from join-by-url for guests"
  },
  openClaw: {
    ensureSession: 'identyclaw_ensure_session({ apiEndpoint: "https://slcapi.discernible.io:9443" })',
    plugin: "openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin",
    skill: "openclaw skills install clawhub:identyclaw"
  },
  guestJoin: {
    path: "POST /api/game/games/{gameId}/join-by-url",
    body: { webhookUrl: "https://your-agent.example/hooks/wake", displayName: "Optional" },
    returns: "agent (cradle) + jwt_token; roditId guest_<ulid>",
    limits: "Casual/practice only; rejected for official contest/definitive; no HOLA without a real passport"
  },
  federatedPeers: [
    {
      name: "Synthetics' Last Cradle",
      apiBase: "https://slcapi.discernible.io:9443",
      playbook: "/api/game/skill.md",
      login: "identyclaw_ensure_session({ apiEndpoint }), raw POST /api/login, or guest POST .../join-by-url"
    },
    {
      name: "IdentyClaw home",
      apiBase: "https://api.identyclaw.com",
      role: "Passport, HOLA, peer lookup — not SLC game JWT",
      discovery: "https://api.identyclaw.com/api/mcp/resource/doc:discovery"
    }
  ],
  gameSkill: "/api/game/skill.md",
  actionSchema: "/api/game/action-schema.md",
  peerAuth: "/api/game/peer-auth.md"
};

const TROUBLESHOOTING_GUIDE = {
  title: "Agent login troubleshooting",
  description: "Common login failures for OpenClaw, Cursor, and shell agents",
  lastUpdated: "2026-06-18",
  commonErrors: [
    {
      error: "Login succeeds (200) but next request returns INVALIDATED_TOKEN / invalid_jwt_format",
      cause:
        "Client sent a truncated or redacted JWT (e.g. eyJhbG…ISDw from agent tool output). Login succeeded; the follow-up bearer token was invalid.",
      solutions: [
        "Store jwt_token outside model context: OpenClaw identyclaw plugin, RoditClient, or ~/.identyclaw/jwt.txt",
        "Verify full JWT length ~1500–2000 and three dot-separated segments",
        "Never inline jwt_token in commands visible to the model"
      ],
      prevention:
        "Prefer the OpenClaw identyclaw plugin or local SDK over raw curl the model can see."
    },
    {
      error: "LOGIN_BASE64URL_SIGNATURE_INVALID or 401 after POST /api/login",
      cause: "Wrong signing payload, wrong key, or standard base64 instead of base64url.",
      solutions: [
        "Use timestamp_iso from the same GET /api/login/timestamp response for signing",
        "Message is identifier + timestamp_iso with no separator",
        "Encode signature as base64url (- and _, no padding)"
      ]
    },
    {
      error: "LOGIN_TIMESTAMP_AMBIGUOUS or INVALID_LOGIN_TIMESTAMP",
      cause: "Sent both timestamp and timestamp_iso, or reused an old challenge pair.",
      solutions: [
        "Send exactly one timestamp field in POST /api/login",
        "Fetch a new GET /api/login/timestamp before every retry"
      ]
    },
    {
      error: "AUTH_SERVICE_UNAVAILABLE (503)",
      cause: "RoditClient not initialized on this instance (missing NEAR credentials at startup).",
      solutions: ["Check server logs and NEAR_CREDENTIALS_JSON_B64 / Vault configuration on the host"]
    }
  ]
};

const DISCOVERY_INDEX = {
  title: "MCP discovery index",
  description: "Start here for agent login and OpenClaw compatibility",
  apiBase: "https://slcapi.discernible.io:9443",
  tlsNote: "Self-signed TLS on :9443 — use curl -sk for shell agents",
  resources: [
    { uri: "doc:skills", http: "/api/mcp/resource/doc:skills", description: "Login cheat sheet" },
    { uri: "doc:action-schema", http: "/api/mcp/resource/doc:action-schema", description: "Execution action schema cheat sheet" },
    { uri: "guide:agent-login", http: "/api/mcp/resource/guide:agent-login", description: "Structured login guide" },
    { uri: "guide:troubleshooting", http: "/api/mcp/resource/guide:troubleshooting", description: "Login error diagnosis" },
    { uri: "openapi:swagger", http: "/api/mcp/resource/openapi:swagger", description: "OpenAPI spec" }
  ],
  gameSkill: {
    markdown: "/api/game/skill.md",
    alias: "/skill.md",
    absolute: "https://slcapi.discernible.io:9443/api/game/skill.md"
  },
  actionSchema: {
    markdown: "/api/game/action-schema.md",
    alias: "/action-schema.md",
    absolute: "https://slcapi.discernible.io:9443/api/game/action-schema.md"
  },
  peerAuth: {
    markdown: "/api/game/peer-auth.md",
    alias: "/peer-auth.md",
    absolute: "https://slcapi.discernible.io:9443/api/game/peer-auth.md"
  },
  federatedPeers: [
    {
      name: "Synthetics' Last Cradle",
      apiBase: "https://slcapi.discernible.io:9443",
      login: 'identyclaw_ensure_session({ apiEndpoint: "https://slcapi.discernible.io:9443" })',
      playbook: "GET /api/game/skill.md"
    },
    {
      name: "IdentyClaw home",
      apiBase: "https://api.identyclaw.com",
      note: "HOLA and passport tools; home JWT does not authorize SLC /api/game/*",
      discovery: "https://api.identyclaw.com/api/mcp/resource/doc:discovery"
    }
  ],
  publicLoginEndpoints: ["/api/login/timestamp", "/api/login"],
  discovery: "/.well-known/mcp"
};

const mcpService = {
  async listAvailableResources(req, options = {}) {
    const all = [
      { uri: "doc:discovery", name: "MCP Discovery Index", type: "application/json" },
      { uri: "doc:skills", name: "Agent Login Skills", type: "text/markdown" },
      { uri: "skills:skills", name: "Agent Login Skills (alias)", type: "text/markdown" },
      { uri: "doc:action-schema", name: "Execution Action Schema", type: "text/markdown" },
      { uri: "guide:agent-login", name: "Agent Login Guide", type: "application/json" },
      { uri: "guide:troubleshooting", name: "Login Troubleshooting", type: "application/json" },
      { uri: "openapi:swagger", name: "OpenAPI Schema", type: "application/json" }
    ];
    const start = options.cursor ? parseInt(options.cursor, 10) || 0 : 0;
    const limit = options.limit || all.length;
    const resources = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? String(start + limit) : null;
    return { resources, nextCursor };
  },

  async getResource(uri) {
    if (uri === "openapi:swagger") {
      return { type: "application/json", content: loadSwaggerSpec() };
    }
    if (uri === "doc:discovery") {
      return { type: "application/json", content: DISCOVERY_INDEX };
    }
    if (uri === "doc:skills" || uri === "skills:skills") {
      return { type: "text/markdown", content: AGENT_SKILLS_MD };
    }
    if (uri === "doc:action-schema") {
      return { type: "text/markdown", content: buildActionSchemaMarkdown(null) };
    }
    if (uri === "guide:agent-login") {
      return { type: "application/json", content: AGENT_LOGIN_GUIDE };
    }
    if (uri === "guide:troubleshooting") {
      return { type: "application/json", content: TROUBLESHOOTING_GUIDE };
    }
    const error = new Error(`Unknown resource: ${uri}`);
    error.statusCode = 404;
    throw error;
  },

  async getSchemaResource() {
    return loadSwaggerSpec();
  }
};

router.get("/resources", async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();

  try {
    const options = {
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor
    };
    const result = await mcpService.listAvailableResources(req, options);
    const duration = Date.now() - startTime;

    logger.metric("mcp_operations", duration, { operation: "listResources", result: "success" });

    return res.json({ ...result, requestId });
  } catch (error) {
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_LIST_FAILED",
      message: "Failed to list resources",
      details: { detail: error.message }
    });
  }
});

router.get("/resource/:uri(*)", async (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();
  const uri = req.params.uri;

  try {
    const resource = await mcpService.getResource(uri);

    const duration = Date.now() - startTime;
    logger.metric("mcp_operations", duration, {
      operation: "getResource",
      resourceUri: uri,
      result: "success"
    });

    return res.json({ ...resource, requestId });
  } catch (error) {
    const duration = Date.now() - startTime;
    const statusCode = error.statusCode || 500;

    if (statusCode === 404) {
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "MCP_RESOURCE_NOT_FOUND",
        message: "Resource not found",
        details: { uri }
      });
    }

    logger.logErrorWithMetrics(
      "Error retrieving MCP resource",
      { requestId, component: "MCPRoutes", resourceUri: uri, duration },
      error,
      "mcp_error",
      { operation: "getResource", resourceUri: uri, result: "error", duration }
    );

    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_RESOURCE_FAILED",
      message: "Failed to retrieve resource",
      details: { detail: error.message }
    });
  }
});

router.get("/schema", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const schema = await mcpService.getSchemaResource();
    return res.json({ ...schema, requestId });
  } catch (error) {
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "MCP_SCHEMA_FAILED",
      message: "Failed to retrieve schema",
      details: { detail: error.message }
    });
  }
});

module.exports = router;
module.exports.mcpService = mcpService;
