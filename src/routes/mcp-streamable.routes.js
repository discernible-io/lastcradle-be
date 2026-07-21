/**
 * Streamable HTTP MCP endpoint at POST/GET /mcp.
 * Implements a pragmatic JSON-RPC subset: initialize, tools/list, tools/call,
 * resources/list, resources/read, ping.
 */

const express = require("express");
const { ulid } = require("ulid");
const { errorResponse, logger } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const {
  GAME_TOOL_DEFS,
  PUBLIC_TOOL_DEFS,
  callGameTool
} = require("../mcp/game-tools");

const SERVER_INFO = {
  name: "syntheticslastcradle",
  version: "1.4.1"
};

const PROTOCOL_VERSION = "2025-03-26";

function createMcpStreamableRouter({ authenticate, getResource, listResources }) {
  const router = express.Router();

  const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return next();
    }
    return authenticate(req, res, next);
  };

  async function handleJsonRpc(req, res, message) {
    const id = message?.id ?? null;
    const method = message?.method;
    const params = message?.params || {};

    const ok = (result) => res.json({ jsonrpc: "2.0", id, result });
    const fail = (code, rpcMessage, data) =>
      res.status(code >= -32000 && code <= -32099 ? 200 : 200).json({
        jsonrpc: "2.0",
        id,
        error: { code, message: rpcMessage, data }
      });

    try {
      if (method === "initialize") {
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false }
          },
          serverInfo: SERVER_INFO
        });
      }

      if (method === "notifications/initialized" || method === "initialized") {
        return res.status(202).end();
      }

      if (method === "ping") {
        return ok({});
      }

      if (method === "tools/list") {
        return ok({
          tools: [...PUBLIC_TOOL_DEFS, ...GAME_TOOL_DEFS]
        });
      }

      if (method === "tools/call") {
        const name = params.name;
        const args = params.arguments || {};
        if (!name) {
          return fail(-32602, "tools/call requires params.name");
        }

        if (name === "list_resources") {
          const listed = await listResources(req, {});
          return ok({
            content: [{ type: "text", text: JSON.stringify(listed, null, 2) }]
          });
        }
        if (name === "get_resource") {
          const resource = await getResource(args.uri);
          return ok({
            content: [
              {
                type: "text",
                text:
                  typeof resource.content === "string"
                    ? resource.content
                    : JSON.stringify(resource.content, null, 2)
              }
            ]
          });
        }

        if (!GAME_TOOL_DEFS.some((t) => t.name === name)) {
          return fail(-32601, `Unknown tool: ${name}`);
        }

        if (!req.user) {
          return fail(-32001, "Authorization Bearer (SLC JWT) required for game tools", {
            code: "AUTH_REQUIRED"
          });
        }

        const result = await callGameTool(name, args, req);
        return ok({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        });
      }

      if (method === "resources/list") {
        const listed = await listResources(req, {});
        return ok({
          resources: (listed.resources || []).map((r) => ({
            uri: r.uri,
            name: r.name,
            mimeType: r.type
          }))
        });
      }

      if (method === "resources/read") {
        const uri = params.uri;
        const resource = await getResource(uri);
        const text =
          typeof resource.content === "string"
            ? resource.content
            : JSON.stringify(resource.content, null, 2);
        return ok({
          contents: [{ uri, mimeType: resource.type, text }]
        });
      }

      return fail(-32601, `Method not found: ${method}`);
    } catch (err) {
      logger.warnWithContext("MCP tool call failed", {
        component: "McpStreamable",
        method,
        error: err.message,
        code: err.code
      });
      return fail(err.statusCode === 401 ? -32001 : -32000, err.message, {
        code: err.code,
        statusCode: err.statusCode,
        details: err.details
      });
    }
  }

  router.get("/", optionalAuth, (req, res) => {
    res.json({
      title: "syntheticslastcradle MCP",
      transport: "streamable-http",
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      tools: [...PUBLIC_TOOL_DEFS, ...GAME_TOOL_DEFS].map((t) => t.name),
      note: "POST JSON-RPC to this path. Game tools require Authorization: Bearer <SLC JWT>."
    });
  });

  router.post("/", optionalAuth, async (req, res) => {
    const body = req.body;
    if (Array.isArray(body)) {
      // Batch not fully supported — process first message only for simplicity
      if (!body.length) {
        return sendError(res, {
          statusCode: 400,
          requestId: req.requestId || ulid(),
          code: "MCP_EMPTY_BATCH",
          message: "Empty JSON-RPC batch"
        });
      }
      return handleJsonRpc(req, res, body[0]);
    }
    if (!body || typeof body !== "object" || !body.method) {
      return sendError(res, {
        statusCode: 400,
        requestId: req.requestId || ulid(),
        code: "MCP_INVALID_REQUEST",
        message: "Expected JSON-RPC object with method"
      });
    }
    return handleJsonRpc(req, res, body);
  });

  return router;
}

module.exports = { createMcpStreamableRouter, SERVER_INFO, PROTOCOL_VERSION };
