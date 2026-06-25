#!/usr/bin/env node
/**
 * Align Game API paths in api-docs/swagger.json with runtime auth policy:
 * - Most routes: JWT only (IdentyClaw / RODiT passport login) — no METHOD_PERMISSION_MAP.
 * - Operator routes: JWT + GAME_PRIVILEGED_RODIT_ID (hardcoded administrator).
 *
 * Usage: node scripts/sync-game-openapi-auth.js
 */

const fs = require("fs");
const path = require("path");
const { gameSchemas } = require("./game-openapi-schemas");

const SWAGGER_PATH = path.join(__dirname, "..", "api-docs", "swagger.json");

const GAME_AUTH_JWT = "jwt-passport";
const GAME_AUTH_PRIVILEGED = "privileged-rodit-id";
const GAME_AUTH_PUBLIC = "public-spectator";

const PUBLIC_SPECTATOR_PATHS = new Set([
  "/api/game/games",
  "/api/game/contests",
  "/api/game/narrative",
  "/api/game/games/{gameId}/state",
  "/api/game/games/{gameId}/messages",
  "/api/game/games/{gameId}/trades",
  "/api/game/games/{gameId}/events"
]);

const PRIVILEGED_POST_PATHS = new Set(["/api/game/contests", "/api/game/contest-series"]);

const GAME_ERROR_409 = {
  description: "Conflict (game state or phase)",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" }
    }
  }
};

const GAME_ERROR_400 = {
  description: "Bad request",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" }
    }
  }
};

const GAME_ERROR_403 = {
  description: "Forbidden — GAME_PRIVILEGED_RODIT_ID required",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorResponse" }
    }
  }
};

function patchGameIdParameter(parameters = []) {
  for (const param of parameters) {
    if (param.name === "gameId" && param.in === "path") {
      param.schema = {
        type: "string",
        description: "Game identifier (ULID assigned at lobby creation)"
      };
      delete param.schema.format;
    }
  }
  return parameters;
}

function stripPermissionScopes(operation) {
  delete operation["x-permission-scopes"];
}

function isPrivilegedOperation(pathStr, method) {
  return PRIVILEGED_POST_PATHS.has(pathStr) && method === "post";
}

const JWT_SCOPE_SUFFIX =
  "Any authenticated IdentyClaw / RODiT passport holder (JWT from `POST /api/login`). Does not use METHOD_PERMISSION_MAP scopes.";
const PUBLIC_SPECTATOR_SUFFIX =
  "Public read-only spectator access — no JWT required. Optional Bearer JWT lets joined players see their own inventory in state.";
const PRIVILEGED_SUFFIX =
  "Requires the server-configured game administrator identity (`GAME_PRIVILEGED_RODIT_ID`) in addition to a valid JWT.";

function stripAuthSuffix(description = "") {
  return description
    .split(JWT_SCOPE_SUFFIX)
    .join("")
    .split(PUBLIC_SPECTATOR_SUFFIX)
    .join("")
    .split(PRIVILEGED_SUFFIX)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function isPublicSpectatorOperation(pathStr, method) {
  return method === "get" && PUBLIC_SPECTATOR_PATHS.has(pathStr);
}

function setGameAuth(operation, authMode, pathStr, method) {
  stripPermissionScopes(operation);
  operation["x-game-auth"] = authMode;
  const base = stripAuthSuffix(operation.description || operation.summary || "");
  if (authMode === GAME_AUTH_PUBLIC) {
    operation.description = [base, PUBLIC_SPECTATOR_SUFFIX].filter(Boolean).join(" ");
    delete operation.security;
  } else if (authMode === GAME_AUTH_PRIVILEGED) {
    operation.description = [base, PRIVILEGED_SUFFIX].filter(Boolean).join(" ");
  } else if (pathStr === "/api/game/games" && method === "post") {
    operation.description = [
      base,
      "Casual lobbies: any authenticated IdentyClaw / RODiT passport holder (JWT from `POST /api/login`). Official contest presets (`preset: contest|definitive` or 50-player min/max) require `GAME_PRIVILEGED_RODIT_ID`."
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    operation.description = [base, JWT_SCOPE_SUFFIX].filter(Boolean).join(" ");
  }
}

function addJoinResponses(responses) {
  responses["409"] = GAME_ERROR_409;
}

function addPhaseResponses(responses) {
  responses["409"] = GAME_ERROR_409;
}

function addPrivilegedResponses(responses) {
  if (!responses["403"]) {
    responses["403"] = GAME_ERROR_403;
  }
}

function defineGameSchemas(spec) {
  spec.components.schemas.GameId = {
    type: "string",
    description: "Game identifier (ULID assigned at lobby creation)"
  };
  Object.assign(spec.components.schemas, gameSchemas);
}

function wireGameResponseSchemas(spec) {
  const joinPost = spec.paths["/api/game/games/{gameId}/join"]?.post;
  if (joinPost?.responses?.["201"]) {
    joinPost.responses["201"].content = {
      "application/json": {
        schema: { $ref: "#/components/schemas/GameJoinResponse" }
      }
    };
  }

  const startPost = spec.paths["/api/game/games/{gameId}/start"]?.post;
  if (startPost?.responses?.["200"]) {
    startPost.responses["200"].content = {
      "application/json": {
        schema: { $ref: "#/components/schemas/GameStartResponse" }
      }
    };
  }

  const stateGet = spec.paths["/api/game/games/{gameId}/state"]?.get;
  if (stateGet?.responses?.["200"]) {
    stateGet.responses["200"].content = {
      "application/json": {
        schema: { $ref: "#/components/schemas/GamePublicStateResponse" }
      }
    };
  }

  const eventsGet = spec.paths["/api/game/games/{gameId}/events"]?.get;
  if (eventsGet?.responses?.["200"]) {
    eventsGet.responses["200"].description =
      "SSE stream (`text/event-stream`). Sends an initial `connected` event, then pub/sub events (`phase_change`, `turn_advanced`, `game_started`, `game_cancelled`, `game_finished`, `prize_settlement`). Each event is framed as `event: <type>\\ndata: <json>\\n\\n` where JSON matches `GameSseEventData` plus `requestId`. Heartbeat comments every 15s (`: ping <timestamp>`).";
    eventsGet.responses["200"].content = {
      "text/event-stream": {
        schema: {
          type: "string",
          description: "SSE wire format; parse `data` lines as GameSseEventData JSON"
        },
        examples: {
          connected: {
            summary: "Initial connected event",
            value:
              'event: connected\ndata: {"type":"connected","gameId":"01JABCDEF","status":"running","phase":"negotiation","currentTurn":1,"requestId":"01JREQUEST"}\n\n'
          },
          phase_change: {
            summary: "Phase transition",
            value:
              'event: phase_change\ndata: {"type":"phase_change","gameId":"01JABCDEF","phase":"message_report","currentTurn":1,"messageReportEndsAt":"2026-06-25T12:02:00.000Z","at":"2026-06-25T12:00:00.000Z","requestId":"01JREQUEST"}\n\n'
          }
        }
      }
    };
  }
}

function patchInfoDescription(description) {
  const authBlock = `### Game API authentication

**Spectators (public):** Read-only routes for live following — \`GET /api/game/games\`, \`GET /api/game/games/{gameId}/state\`, \`GET /api/game/games/{gameId}/messages\`, \`GET /api/game/games/{gameId}/trades\`, \`GET /api/game/games/{gameId}/events\`, \`GET /api/game/contests\`, \`GET /api/game/narrative\` — require no JWT. Optional Bearer token upgrades state for joined players only.

**Players (free join):** Authenticate with an IdentyClaw / RODiT passport via \`POST /api/login\`, then call mutating game routes with \`Authorization: Bearer <jwt_token>\`. No METHOD_PERMISSION_MAP scopes apply to \`/api/game/*\`.

**Game administrator (operator):** \`POST /api/game/contests\`, \`POST /api/game/contest-series\`, and \`POST /api/game/games\` with an official contest preset require the JWT identity to match \`GAME_PRIVILEGED_RODIT_ID\` in server configuration.

Operations carry \`x-game-auth\`: \`public-spectator\`, \`jwt-passport\` (default), or \`privileged-rodit-id\` (operator).`;

  if (description.includes("### Game API authentication")) {
    return description.replace(
      /### Game API authentication[\s\S]*?(?=### Negotiation and reputation)/,
      `${authBlock}\n\n`
    );
  }

  return description.replace(
    "## Game API\nAuthenticated",
    `## Game API\n${authBlock}\n\nAuthenticated`
  );
}

function main() {
  const spec = JSON.parse(fs.readFileSync(SWAGGER_PATH, "utf8"));

  spec.info.description = patchInfoDescription(spec.info.description);
  defineGameSchemas(spec);

  spec.components.parameters = spec.components.parameters || {};
  spec.components.parameters.gameId = {
    name: "gameId",
    in: "path",
    required: true,
    schema: { $ref: "#/components/schemas/GameId" }
  };

  const join409Codes =
    "JOIN_WINDOW_NOT_OPEN, JOIN_WINDOW_CLOSED, GAME_FULL, GAME_NOT_JOINABLE";
  const phase409Codes =
    "GAME_NOT_RUNNING, NOT_NEGOTIATION_PHASE, NOT_MESSAGE_REPORT_PHASE, NOT_EXECUTION_PHASE, AGENT_DEAD";

  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    if (!pathStr.startsWith("/api/game/")) {
      continue;
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) {
        continue;
      }

      const privileged = isPrivilegedOperation(pathStr, method);
      const publicSpectator = isPublicSpectatorOperation(pathStr, method);
      const authMode = privileged
        ? GAME_AUTH_PRIVILEGED
        : publicSpectator
          ? GAME_AUTH_PUBLIC
          : GAME_AUTH_JWT;
      setGameAuth(operation, authMode, pathStr, method);

      if (operation.parameters) {
        operation.parameters = patchGameIdParameter(operation.parameters);
      }

      if (pathStr.endsWith("/join")) {
        addJoinResponses(operation.responses || {});
        operation.responses["201"].description = `Joined. May return autoStart when lobby auto-starts. Errors include ${join409Codes}.`;
      }

      if (pathStr.endsWith("/start")) {
        addPhaseResponses(operation.responses || {});
        operation.responses["400"] = {
          ...GAME_ERROR_400,
          description: "Insufficient agents (INSUFFICIENT_AGENTS)"
        };
        operation.responses["200"].description =
          "Game started. Returns public state snapshot. Errors include GAME_ALREADY_STARTED (409).";
      }

      if (
        pathStr.endsWith("/message") ||
        pathStr.endsWith("/message-report") ||
        pathStr.endsWith("/action")
      ) {
        addPhaseResponses(operation.responses || {});
        operation.responses["201"].description = `${
          operation.responses["201"]?.description || "Success"
        }. Phase errors include ${phase409Codes}.`;
      }

      if (privileged || (pathStr === "/api/game/games" && method === "post")) {
        addPrivilegedResponses(operation.responses || {});
      }
    }
  }

  for (const contestPath of ["/api/game/contests", "/api/game/contest-series"]) {
    const post = spec.paths[contestPath]?.post;
    if (post?.requestBody?.content?.["application/json"]?.schema) {
      const schema = post.requestBody.content["application/json"].schema;
      schema.required = ["practiceStartsAt"];
      post.requestBody.required = true;
    }
  }

  const actionPost = spec.paths["/api/game/games/{gameId}/action"]?.post;
  if (actionPost) {
    actionPost.requestBody.content["application/json"].schema = {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", enum: ["none", "transfer", "invest"] },
        toAgentId: { type: "string", description: "Recipient agent id (transfer)" },
        energy: { type: "number" },
        water: { type: "number" },
        compute: { type: "number" },
        target: {
          type: "string",
          enum: ["energy", "water", "compute"],
          description: "Capacity target (invest; energy, water, compute must be equal)"
        },
        amount: { type: "number", description: "Shorthand for equal E/W/C invest amount" },
        hide: {
          oneOf: [{ type: "number" }, { type: "object", properties: { compute: { type: "number" } } }]
        },
        find: {
          type: "array",
          items: {
            type: "object",
            required: ["targetAgentId", "compute"],
            properties: {
              targetAgentId: { type: "string" },
              compute: { type: "number" }
            }
          }
        }
      }
    };
  }

  wireGameResponseSchemas(spec);

  fs.writeFileSync(SWAGGER_PATH, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  console.log("✓ Patched api-docs/swagger.json for game auth policy");
}

main();
