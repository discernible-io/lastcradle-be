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

const SWAGGER_PATH = path.join(__dirname, "..", "api-docs", "swagger.json");

const GAME_AUTH_JWT = "jwt-passport";
const GAME_AUTH_PRIVILEGED = "privileged-rodit-id";

const PRIVILEGED_PATHS = new Set([
  "/api/game/contests",
  "/api/game/contest-series"
]);

const GAME_ERROR_409 = {
  description: "Conflict (game state or phase)",
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

function setGameAuth(operation, authMode, pathStr, method) {
  stripPermissionScopes(operation);
  operation["x-game-auth"] = authMode;
  if (authMode === GAME_AUTH_PRIVILEGED) {
    operation.description = [
      operation.description || operation.summary || "",
      "Requires the server-configured game administrator identity (`GAME_PRIVILEGED_RODIT_ID`) in addition to a valid JWT."
    ]
      .filter(Boolean)
      .join(" ");
  } else if (pathStr === "/api/game/games" && method === "post") {
    operation.description = [
      operation.description || operation.summary || "",
      "Casual lobbies: any authenticated IdentyClaw / RODiT passport holder (JWT from `POST /api/login`). Official contest presets (`preset: contest|definitive` or 50-player min/max) require `GAME_PRIVILEGED_RODIT_ID`."
    ]
      .filter(Boolean)
      .join(" ");
  } else {
    operation.description = [
      operation.description || operation.summary || "",
      "Any authenticated IdentyClaw / RODiT passport holder (JWT from `POST /api/login`). Does not use METHOD_PERMISSION_MAP scopes."
    ]
      .filter(Boolean)
      .join(" ");
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

function patchInfoDescription(description) {
  const authBlock = `### Game API authentication

**Players (free join):** Authenticate with an IdentyClaw / RODiT passport via \`POST /api/login\`, then call game routes with \`Authorization: Bearer <jwt_token>\`. No METHOD_PERMISSION_MAP scopes apply to \`/api/game/*\`.

**Game administrator (operator):** \`POST /api/game/contests\`, \`POST /api/game/contest-series\`, and \`POST /api/game/games\` with an official contest preset require the JWT identity to match \`GAME_PRIVILEGED_RODIT_ID\` in server configuration.

Operations carry \`x-game-auth\`: \`jwt-passport\` (default) or \`privileged-rodit-id\` (operator).`;

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

  spec.components.schemas.GameId = {
    type: "string",
    description: "Game identifier (ULID assigned at lobby creation)"
  };

  spec.components.schemas.GameJoinResponse = {
    type: "object",
    properties: {
      agent: { type: "object", additionalProperties: true },
      autoStart: { type: "object", additionalProperties: true },
      requestId: { type: "string" }
    }
  };

  spec.components.parameters = spec.components.parameters || {};
  spec.components.parameters.gameId = {
    name: "gameId",
    in: "path",
    required: true,
    schema: { $ref: "#/components/schemas/GameId" }
  };

  const join409Codes =
    "JOIN_WINDOW_NOT_OPEN, JOIN_WINDOW_CLOSED, GAME_FULL, GAME_NOT_JOINABLE";
  const start409Codes = "GAME_ALREADY_STARTED, INSUFFICIENT_AGENTS";
  const phase409Codes =
    "GAME_NOT_RUNNING, NOT_NEGOTIATION_PHASE, NOT_MESSAGE_REPORT_PHASE, NOT_EXECUTION_PHASE, AGENT_DEAD";

  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    if (!pathStr.startsWith("/api/game/")) {
      continue;
    }

    const isPrivilegedPath = PRIVILEGED_PATHS.has(pathStr);

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method)) {
        continue;
      }

      const authMode = isPrivilegedPath ? GAME_AUTH_PRIVILEGED : GAME_AUTH_JWT;
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
        operation.responses["200"].description = `Game started. Errors include ${start409Codes}.`;
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

      if (isPrivilegedPath || (pathStr === "/api/game/games" && method === "post")) {
        addPrivilegedResponses(operation.responses || {});
      }
    }
  }

  // Contest create: practiceStartsAt required
  for (const contestPath of ["/api/game/contests", "/api/game/contest-series"]) {
    const post = spec.paths[contestPath]?.post;
    if (post?.requestBody?.content?.["application/json"]?.schema) {
      const schema = post.requestBody.content["application/json"].schema;
      schema.required = ["practiceStartsAt"];
      post.requestBody.required = true;
    }
  }

  // Action request body schema
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

  const joinPost = spec.paths["/api/game/games/{gameId}/join"]?.post;
  if (joinPost?.responses?.["201"]) {
    joinPost.responses["201"].content = {
      "application/json": {
        schema: { $ref: "#/components/schemas/GameJoinResponse" }
      }
    };
  }

  fs.writeFileSync(SWAGGER_PATH, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  console.log("✓ Patched api-docs/swagger.json for game auth policy");
}

main();
