/**
 * Streamable HTTP MCP transport (aligned with idclawserver-idc).
 * Uses @modelcontextprotocol/sdk StreamableHTTPServerTransport with
 * Mcp-Session-Id sessions and proper GET SSE handling.
 */

const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const {
  GAME_TOOL_DEFS,
  PUBLIC_TOOL_DEFS,
  callGameTool,
  requireRodit
} = require("../mcp/game-tools");

const SERVER_INFO = {
  name: "syntheticslastcradle",
  version: "1.4.2"
};

const transportsBySessionId = {};

// Cap + TTL eviction for anonymous initialize storms (CC-0004).
const MAX_MCP_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 1000);
const MCP_SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 60_000);
const sessionLastSeen = new Map();

function touchMcpSession(sessionId) {
  if (sessionId) {
    sessionLastSeen.set(sessionId, Date.now());
  }
}

function forgetMcpSession(sessionId) {
  if (sessionId) {
    sessionLastSeen.delete(sessionId);
  }
}

async function evictMcpSession(sessionId, reason) {
  const transport = transportsBySessionId[sessionId];
  if (!transport) {
    forgetMcpSession(sessionId);
    return;
  }
  try {
    await transport.close();
  } catch (error) {
    logger.warnWithContext(
      "Error closing idle MCP transport",
      {
        component: "MCPHttpIntegration",
        operation: "evictMcpSession",
        sessionId,
        reason
      },
      error instanceof Error ? error : new Error(String(error))
    );
  }
  delete transportsBySessionId[sessionId];
  forgetMcpSession(sessionId);
}

const mcpSessionEvictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of sessionLastSeen) {
    if (now - ts > MCP_SESSION_TTL_MS) {
      evictMcpSession(sid, "ttl_expired").catch(() => {});
    }
  }
}, Math.max(5_000, Math.floor(MCP_SESSION_TTL_MS / 2)));
if (typeof mcpSessionEvictionTimer.unref === "function") {
  mcpSessionEvictionTimer.unref();
}

function sendMcpTransportSessionError(res, req) {
  if (res.headersSent) {
    return;
  }
  return sendError(res, {
    statusCode: 400,
    requestId: req.requestId || ulid(),
    code: "MCP_TRANSPORT_SESSION_REQUIRED",
    message:
      "MCP Streamable HTTP transport requires a valid Mcp-Session-Id from an MCP client after initialize. Do not bare-GET /mcp.",
    details: { mcpDiscovery: "/.well-known/mcp" }
  });
}

function sendMcpJsonRpcError(res, status, message) {
  if (res.headersSent) {
    return;
  }
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null
  });
}

function resolveSessionId(req) {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return typeof raw === "string" ? raw : undefined;
}

function expressReqFromExtra(extra, fallbackReq) {
  const fromAuth = extra?.authInfo?.extra?.expressReq;
  if (fromAuth) {
    return fromAuth;
  }
  return fallbackReq || { headers: extra?.requestInfo?.headers || {}, user: null };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function toolError(err) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              code: err.code || "MCP_TOOL_ERROR",
              message: err.message,
              statusCode: err.statusCode,
              details: err.details
            }
          },
          null,
          2
        )
      }
    ],
    isError: true
  };
}

async function setupMcpHttpTransport(app, { authenticate, getResource, listResources }) {
  const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return next();
    }
    return authenticate(req, res, () => {
      if (req.user) {
        req.auth = {
          token: authHeader.replace(/^bearer\s+/i, ""),
          clientId: String(req.user.sub || req.user.id || "agent"),
          scopes: [],
          extra: { expressReq: req }
        };
      }
      next();
    });
  };

  const createMcpServer = (boundReq) => {
    const mcpServer = new McpServer({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      instructions:
        "SLC game MCP: list_resources/get_resource are public docs. Game tools (slc_*) require Authorization: Bearer <SLC JWT>. OpenClaw agents should use identyclaw_ensure_session + identyclaw_request (skill paths); remote OpenClaw MCP does not receive the plugin JWT cache. Create lobbies with slc_create when no joinable lobby exists."
    });

    mcpServer.tool(
      "list_resources",
      "Lists available MCP documentation resources",
      {
        limit: z.number().optional(),
        cursor: z.string().optional()
      },
      async ({ limit, cursor }, extra) => {
        const req = expressReqFromExtra(extra, boundReq);
        const result = await listResources(req, { limit, cursor });
        return toolResult(result);
      }
    );

    mcpServer.tool(
      "get_resource",
      "Retrieves an MCP documentation resource by URI",
      { uri: z.string() },
      async ({ uri }, extra) => {
        try {
          const resource = await getResource(uri);
          const text =
            typeof resource.content === "string"
              ? resource.content
              : JSON.stringify(resource.content, null, 2);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return toolError(err);
        }
      }
    );

    const registerGameTool = (def, zodShape) => {
      mcpServer.tool(def.name, def.description, zodShape, async (args, extra) => {
        const req = expressReqFromExtra(extra, boundReq);
        try {
          if (def.name !== "slc_skill") {
            requireRodit(req);
          } else if (!req.user) {
            // skill is readable without auth; still allow
          }
          const result = await callGameTool(def.name, args || {}, req);
          return toolResult(result);
        } catch (err) {
          return toolError(err);
        }
      });
    };

    // Keep schemas aligned with GAME_TOOL_DEFS / REST.
    registerGameTool(
      GAME_TOOL_DEFS.find((t) => t.name === "slc_skill"),
      {}
    );
    registerGameTool(
      GAME_TOOL_DEFS.find((t) => t.name === "slc_games_mine"),
      {}
    );
    registerGameTool(
      GAME_TOOL_DEFS.find((t) => t.name === "slc_lobbies"),
      {}
    );
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_create"), {
      preset: z.enum(["contest", "definitive", "practice"]).optional(),
      config: z.record(z.any()).optional(),
      joiningWindowStartsAt: z.string().optional(),
      displayName: z.string().optional(),
      autoJoin: z.boolean().optional()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_join"), {
      gameId: z.string(),
      displayName: z.string().optional()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_tasks"), {
      includeFinished: z.boolean().optional()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_state"), {
      gameId: z.string()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_message"), {
      gameId: z.string(),
      body: z.string()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_action"), {
      gameId: z.string(),
      type: z.string(),
      payload: z.record(z.any()).optional(),
      hide: z.union([z.number(), z.record(z.any())]).optional(),
      find: z.array(z.record(z.any())).optional()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_project"), {
      gameId: z.string(),
      type: z.string().optional(),
      payload: z.record(z.any()).optional(),
      assumeInbound: z
        .object({
          energy: z.number().optional(),
          water: z.number().optional(),
          compute: z.number().optional()
        })
        .optional(),
      hide: z.union([z.number(), z.record(z.any())]).optional(),
      find: z.array(z.record(z.any())).optional(),
      toAgentId: z.string().optional(),
      energy: z.number().optional(),
      water: z.number().optional(),
      compute: z.number().optional(),
      target: z.enum(["energy", "water", "compute"]).optional(),
      amount: z.number().optional(),
      transfers: z.array(z.record(z.any())).optional(),
      transfer: z.record(z.any()).optional(),
      invest: z.record(z.any()).optional(),
      production: z.record(z.any()).optional(),
      storage: z.record(z.any()).optional(),
      reduceStorage: z.record(z.any()).optional()
    });
    registerGameTool(GAME_TOOL_DEFS.find((t) => t.name === "slc_tick"), {
      actionType: z.string().optional(),
      type: z.string().optional(),
      hide: z.union([z.number(), z.record(z.any())]).optional(),
      find: z.array(z.record(z.any())).optional()
    });

    return mcpServer;
  };

  const mcpPostHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpPostHandler",
      requestId: req.requestId,
      hasSessionId: Boolean(sessionId)
    };

    try {
      let transport = sessionId ? transportsBySessionId[sessionId] : undefined;

      if (sessionId && transport) {
        touchMcpSession(sessionId);
      }

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        if (Object.keys(transportsBySessionId).length >= MAX_MCP_SESSIONS) {
          sendMcpJsonRpcError(res, 429, "Too many active MCP sessions.");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            transportsBySessionId[sid] = transport;
            touchMcpSession(sid);
            logger.infoWithContext("MCP session initialized", {
              ...logContext,
              sessionId: sid
            });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transportsBySessionId[sid]) {
            delete transportsBySessionId[sid];
            forgetMcpSession(sid);
            logger.infoWithContext("MCP session transport closed", {
              ...logContext,
              sessionId: sid
            });
          }
        };

        const mcpServer = createMcpServer(req);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!transport) {
        sendMcpJsonRpcError(res, 400, "Bad Request: No valid MCP transport session.");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.errorWithContext(
        "MCP POST request failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      sendMcpJsonRpcError(res, 500, "Internal server error");
    }
  };

  const mcpGetHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpGetHandler",
      requestId: req.requestId,
      sessionId
    };

    if (!sessionId || !transportsBySessionId[sessionId]) {
      sendMcpTransportSessionError(res, req);
      return;
    }

    try {
      touchMcpSession(sessionId);
      await transportsBySessionId[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.errorWithContext(
        "MCP GET (SSE) request failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = resolveSessionId(req);
    const logContext = {
      component: "MCPHttpIntegration",
      operation: "mcpDeleteHandler",
      requestId: req.requestId,
      sessionId
    };

    if (!sessionId || !transportsBySessionId[sessionId]) {
      sendMcpTransportSessionError(res, req);
      return;
    }

    try {
      touchMcpSession(sessionId);
      await transportsBySessionId[sessionId].handleRequest(req, res);
    } catch (error) {
      logger.errorWithContext(
        "MCP DELETE (session terminate) failed",
        logContext,
        error instanceof Error ? error : new Error(String(error))
      );
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  };

  app.post("/mcp", optionalAuth, mcpPostHandler);
  app.get("/mcp", optionalAuth, mcpGetHandler);
  app.delete("/mcp", optionalAuth, mcpDeleteHandler);

  logger.infoWithContext("Streamable HTTP transport mounted", {
    component: "MCPHttpIntegration",
    operation: "setupMcpHttpTransport",
    mode: "stateful-per-session",
    tools: [...PUBLIC_TOOL_DEFS, ...GAME_TOOL_DEFS].map((t) => t.name)
  });
}

async function closeMcpHttpTransports() {
  clearInterval(mcpSessionEvictionTimer);
  const sessionIds = Object.keys(transportsBySessionId);
  for (const sessionId of sessionIds) {
    try {
      await transportsBySessionId[sessionId].close();
    } catch (error) {
      logger.warnWithContext(
        "Error closing MCP transport",
        { component: "MCPHttpIntegration", operation: "closeMcpHttpTransports", sessionId },
        error instanceof Error ? error : new Error(String(error))
      );
    }
    delete transportsBySessionId[sessionId];
    forgetMcpSession(sessionId);
  }
}

module.exports = {
  setupMcpHttpTransport,
  closeMcpHttpTransports,
  SERVER_INFO
};
