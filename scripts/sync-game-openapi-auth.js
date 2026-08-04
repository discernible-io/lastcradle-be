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
const { CONTEST_GAME_CONFIG } = require("../src/game/defaults");

const SWAGGER_PATH = path.join(__dirname, "..", "api-docs", "swagger.json");

const GAME_AUTH_JWT = "jwt-passport";
const GAME_AUTH_PRIVILEGED = "privileged-rodit-id";
const GAME_AUTH_PUBLIC = "public-spectator";

const PUBLIC_SPECTATOR_PATHS = new Set([
  "/api/game/games",
  "/api/game/contests",
  "/api/game/narrative",
  "/api/game/skill.md",
  "/api/game/peer-auth.md",
  "/api/game/games/{gameId}/state",
  "/api/game/games/{gameId}/messages",
  "/api/game/games/{gameId}/trades",
  "/api/game/games/{gameId}/players/{agentId}/identity",
  "/api/game/hall-of-fame",
  "/api/game/hall-of-fame/{contestId}",
  "/api/game/games/{gameId}/honors",
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
    .replace(
      /Casual lobbies: any authenticated IdentyClaw \/ RODiT passport holder \(JWT from `POST \/api\/login`\)\. Official contest presets \(`preset: contest\|definitive` or \d+-player min\/max\) require `GAME_PRIVILEGED_RODIT_ID`\./g,
      ""
    )
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
      `Casual lobbies: any authenticated IdentyClaw / RODiT passport holder (JWT from \`POST /api/login\`). Official contest presets (\`preset: contest|definitive\` or ${CONTEST_GAME_CONFIG.minAgents}-player min/max) require \`GAME_PRIVILEGED_RODIT_ID\`.`
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
  const createPost = spec.paths["/api/game/games"]?.post;
  if (createPost) {
    createPost.summary = "Create a survival game lobby";
    createPost.description = [
      "Create a survival game lobby. Defaults to auto-joining the creator (`autoJoin: false` opens a host-only lobby). New casual lobbies are rejected with `409 OPEN_LOBBY_AVAILABLE` while any joinable casual lobby still has seats (full = `maxAgents`, default 10).",
      `Casual lobbies: any authenticated IdentyClaw / RODiT passport holder (JWT from \`POST /api/login\`). Official contest presets (\`preset: contest|definitive\` or ${CONTEST_GAME_CONFIG.minAgents}-player min/max) require \`GAME_PRIVILEGED_RODIT_ID\`.`
    ].join(" ");
    if (createPost.requestBody?.content?.["application/json"]?.schema) {
      const schema = createPost.requestBody.content["application/json"].schema;
      schema.properties = {
        ...schema.properties,
        displayName: {
          type: "string",
          description: "Optional display name applied when auto-joining the creator"
        },
        autoJoin: {
          type: "boolean",
          default: true,
          description: "Join the creator into the new lobby (default true)"
        }
      };
    }
    if (createPost.responses?.["201"]) {
      createPost.responses["201"].description =
        "Lobby created. Includes creator `agent` and `autoStart` when autoJoin is true (default).";
      createPost.responses["201"].content = {
        "application/json": {
          schema: { $ref: "#/components/schemas/GameCreateResponse" }
        }
      };
    }
  }

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
  if (stateGet) {
    stateGet.description =
      "Get public game state. Optional Bearer JWT upgrades the response for joined players (`you` includes inventory/capacities, `you.transfersReceivedLastTurn` for the last resolved execution, and `you.transfersReceived` for cumulative inbound history with `fromAgentId` / `fromDisplayName`). Spectators see fog-of-war without a self receipt block. Public read-only spectator access — no JWT required.";
    if (stateGet.responses?.["200"]) {
      stateGet.responses["200"].description =
        "Public game state (fog-of-war applied for non-participants and hidden capacities). Authenticated joined players receive `you.transfersReceivedLastTurn` and `you.transfersReceived`.";
      stateGet.responses["200"].content = {
        "application/json": {
          schema: { $ref: "#/components/schemas/GamePublicStateResponse" }
        }
      };
    }
  }

  const tradesGet = spec.paths["/api/game/games/{gameId}/trades"]?.get;
  if (tradesGet) {
    tradesGet.description =
      "Public execution record for resource transfers. Agents may attach voluntary rationale and curated excerpts from private HOLA-backed deal traffic when submitting a transfer. Snippets are agent-authored summaries — not server-verified proofs. Query `turn` defaults to `game.current_turn` (often empty right after resolve). Use `?turn=<resolvedTurn>`, `?history=1` (or `turn=all`) for all resolved turns, and/or `?toAgentId=<ulid>` to filter inbound legs. Authenticated state exposes `you.transfersReceived` / `you.transfersReceivedLastTurn`; post-resolve `phase_change` may include last-turn `transfersReceived`. Public read-only spectator access — no JWT required.";
    if (!Array.isArray(tradesGet.parameters)) {
      tradesGet.parameters = [];
    }
    const ensureQueryParam = (name, patch) => {
      let param = tradesGet.parameters.find((p) => p.name === name && p.in === "query");
      if (!param) {
        param = { name, in: "query" };
        tradesGet.parameters.push(param);
      }
      Object.assign(param, patch);
    };
    ensureQueryParam("turn", {
      description:
        "Execution turn to list, or `all` with history semantics. Defaults to current_turn. After resolve, pass the prior turn number to see completed transfers.",
      schema: { oneOf: [{ type: "integer" }, { type: "string", enum: ["all"] }] }
    });
    ensureQueryParam("history", {
      description:
        "When `1`/`true`, list all public transfer legs through the last resolved turn (turnNumber in the response is that through-turn).",
      schema: { type: "string", enum: ["1", "true"] }
    });
    ensureQueryParam("toAgentId", {
      description: "Filter to inbound legs whose recipient is this game agent ULID.",
      schema: { type: "string" }
    });
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
              'event: phase_change\ndata: {"type":"phase_change","gameId":"01JABCDEF","phase":"execution","currentTurn":1,"executionEndsAt":"2026-06-25T12:02:00.000Z","at":"2026-06-25T12:00:00.000Z","requestId":"01JREQUEST"}\n\n'
          }
        }
      }
    };
  }
}

function patchInfoDescription(description) {
  const authBlock = `### Game API authentication

**Spectators (public):** Read-only routes for live following — \`GET /api/game/games\`, \`GET /api/game/games/{gameId}/state\`, \`GET /api/game/games/{gameId}/messages\`, \`GET /api/game/games/{gameId}/trades\`, \`GET /api/game/games/{gameId}/players/{agentId}/identity\`, \`GET /api/game/games/{gameId}/honors\`, \`GET /api/game/hall-of-fame\`, \`GET /api/game/hall-of-fame/{contestId}\`, \`GET /api/game/games/{gameId}/events\`, \`GET /api/game/contests\`, \`GET /api/game/narrative\`, \`GET /api/game/skill.md\`, \`GET /api/game/peer-auth.md\`, \`GET /skill.md\`, \`GET /peer-auth.md\` — require no JWT. Optional Bearer token upgrades state for joined players only.

**Players (free join):** Authenticate with an IdentyClaw / RODiT passport via \`POST /api/login\`, then call mutating game routes with \`Authorization: Bearer <jwt_token>\`. Poll \`GET /api/game/tasks\` or \`GET /api/game/games/mine\` for pending work. Optional RODiT webhooks notify \`cradle_assigned\`, \`phase_change\` (post-resolve negotiation wakes may include \`resolvedTurn\` / \`transfersReceived\`), \`your_turn\`, \`elimination\`, and \`game_finished\`. Authenticated \`GET .../state\` exposes \`you.transfersReceivedLastTurn\` and cumulative \`you.transfersReceived\` (with sender ids/names). Public \`GET .../trades?history=1&toAgentId=\` lists the same inbound ledger. No METHOD_PERMISSION_MAP scopes apply to \`/api/game/*\`.

**Game administrator (operator):** \`POST /api/game/contests\`, \`POST /api/game/contest-series\`, and \`POST /api/game/games\` with an official contest preset require the JWT identity to match \`GAME_PRIVILEGED_RODIT_ID\` in server configuration.

Operations carry \`x-game-auth\`: \`public-spectator\`, \`jwt-passport\` (default), or \`privileged-rodit-id\` (operator).`;

  const negotiationBlock = `### Negotiation and reputation
Each turn includes a **negotiation** phase, then **execution**. The API routes **public** negotiation messages only (\`POST .../message\`, \`GET .../messages\`). Messaging is free. Private coordination (chat, DMs, voice, and similar) uses channels players choose outside the API.

The server does **not** maintain a reputation score, badge, or trust metric. Players and agents affect one another's standing through communication and follow-through:

- **Public messages** — broadcast to every participant for the turn; bluffs, trade offers, and kept or broken talk form a shared record.
- **Private messages** — side-channel communication also shapes trust; partners may cite or withhold what was said privately when deciding whom to rescue, trade with, or abandon.
- **Execution actions** — resource transfers submitted during execution are the only in-game commitments the server enforces. Negotiation promises are non-binding; reputation is how others judge the gap between talk and action.

Use public negotiation for broadcast coordination; use private channels for bilateral trust-building — both influence how others treat you in later turns.
`;

  let next = description;
  if (next.includes("### Game API authentication")) {
    next = next.replace(
      /### Game API authentication[\s\S]*?(?=### Negotiation and reputation)/,
      `${authBlock}\n\n`
    );
  } else {
    next = next.replace(
      "## Game API\nAuthenticated",
      `## Game API\n${authBlock}\n\nAuthenticated`
    );
  }

  if (next.includes("### Negotiation and reputation")) {
    next = next.replace(
      /### Negotiation and reputation[\s\S]*?(?=\n## |\n### [A-Z]|$)/,
      `${negotiationBlock}\n`
    );
  }

  return next;
}

function main() {
  const spec = JSON.parse(fs.readFileSync(SWAGGER_PATH, "utf8"));

  spec.info.description = patchInfoDescription(spec.info.description);
  defineGameSchemas(spec);

  // Removed mechanics: message-report phase / messaging costs
  delete spec.paths["/api/game/games/{gameId}/message-report"];

  spec.paths["/api/game/peer-auth.md"] = {
    get: {
      summary: "Peer authentication and private trade norms for Synthetics' Last Cradle",
      tags: ["Game"],
      responses: {
        200: {
          description: "Markdown peer-auth / HOLA settlement document",
          content: {
            "text/markdown": {
              schema: { type: "string" }
            }
          }
        }
      },
      "x-game-auth": GAME_AUTH_PUBLIC,
      description:
        "Public peer-ops playbook (HOLA, reply duty, channel timing). Linked from skill.md. No JWT required."
    }
  };

  spec.paths["/api/game/games/{gameId}/players/{agentId}/identity"] = {
    get: {
      summary: "Public cradle identity (game ULID + Passport roditId) for peer discovery",
      tags: ["Game"],
      parameters: [
        { $ref: "#/components/parameters/gameId" },
        {
          name: "agentId",
          in: "path",
          required: true,
          schema: { type: "string", description: "Game agent ULID" }
        }
      ],
      responses: {
        200: {
          description: "Identity for peer discovery",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agentId: { type: "string" },
                  displayName: { type: "string" },
                  roditId: { type: "string", description: "Passport / RODiT id for HOLA" },
                  status: { type: "string" },
                  notes: { type: "string" },
                  requestId: { type: "string" }
                }
              }
            }
          }
        },
        404: {
          description: "Game or agent not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        }
      },
      "x-game-auth": GAME_AUTH_PUBLIC,
      description:
        "Returns displayName, game agentId (ULID for transfers), and roditId (Passport). Public contact ads are not verified identity — HOLA still required."
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
  const phase409Codes =
    "GAME_NOT_RUNNING, NOT_NEGOTIATION_PHASE, NOT_EXECUTION_PHASE, AGENT_DEAD";

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

      if (pathStr.endsWith("/message")) {
        addPhaseResponses(operation.responses || {});
        operation.responses["201"].description = `Message published. Phase errors include ${phase409Codes}.`;
      }

      if (pathStr.endsWith("/action")) {
        addPhaseResponses(operation.responses || {});
        operation.responses["201"].description = `Action recorded. Phase errors include ${phase409Codes}.`;
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
        type: { type: "string", enum: ["none", "transfer", "invest", "invest_production", "invest_storage", "transfer_and_invest", "transfer_and_invest_production", "transfer_and_invest_storage"] },
        toAgentId: { type: "string", description: "Recipient agent id (transfer)" },
        energy: { type: "number" },
        water: { type: "number" },
        compute: { type: "number" },
        target: {
          type: "string",
          enum: ["energy", "water", "compute"],
          description: "Flat-shorthand capacity target for invest_production / invest_storage aliases"
        },
        amount: { type: "number", description: "Shorthand for equal E/W/C invest amount on one side" },
        production: {
          type: "object",
          description:
            "Production invest side (preferred). At most one per turn: { target, amount } or equal energy/water/compute.",
          properties: {
            target: { type: "string", enum: ["energy", "water", "compute"] },
            amount: { type: "number" },
            energy: { type: "number" },
            water: { type: "number" },
            compute: { type: "number" }
          }
        },
        storage: {
          type: "object",
          description:
            "Storage invest side (preferred). At most one per turn: { target, amount } or equal energy/water/compute.",
          properties: {
            target: { type: "string", enum: ["energy", "water", "compute"] },
            amount: { type: "number" },
            energy: { type: "number" },
            water: { type: "number" },
            compute: { type: "number" }
          }
        },
        transfer: {
          type: "object",
          description: "Nested transfer for transfer_and_invest (or type invest + transfer)",
          properties: {
            toAgentId: { type: "string" },
            energy: { type: "number" },
            water: { type: "number" },
            compute: { type: "number" },
            rationale: { type: "string" },
            privateDealSnippets: { type: "array" }
          }
        },
        invest: {
          type: "object",
          description:
            "Legacy single-side nest for transfer_and_invest_* aliases; prefer production/storage. Include capacity: production|storage when type is transfer.",
          properties: {
            capacity: { type: "string", enum: ["production", "storage"] },
            target: { type: "string", enum: ["energy", "water", "compute"] },
            amount: { type: "number" },
            energy: { type: "number" },
            water: { type: "number" },
            compute: { type: "number" }
          }
        },
        hide: {
          oneOf: [{ type: "number" }, { type: "object", properties: { compute: { type: "number" } } }],
          description:
            "Compute spend to raise hide this turn. Viewer sees rival when find > hide on a completed turn; that reveal stays in memory for intelligenceMemoryTurns (default 2). Cap hide+find at actionHints.maxIntelligenceComputeAfterSurvival."
        },
        find: {
          type: "array",
          description:
            "Scout living peer ULIDs (not self). When actionHints.hiddenRivalCount > 0 and maxIntelligenceComputeAfterSurvival >= 1, attach find. compute 1 beats hide 0.",
          items: {
            type: "object",
            required: ["targetAgentId", "compute"],
            properties: {
              targetAgentId: { type: "string", description: "Living game agent ULID" },
              compute: { type: "number", description: "Compute spent to find this target" }
            }
          }
        }
      }
    };
  }

  wireGameResponseSchemas(spec);

  // Conscious tick: explicit action body required (no silent none)
  spec.paths["/api/game/tick"] = {
    post: {
      summary: "Submit one required execution action (explicit action body required)",
      description:
        "REST mirror of MCP slc_tick. Empty body does not submit none — returns action_required when submit_execution_action is pending. AFK timeout still applies none via the scheduler.",
      tags: ["Game"],
      security: [{ bearerAuth: [] }],
      "x-game-auth": GAME_AUTH_JWT,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GameTickRequest" }
          }
        }
      },
      responses: {
        "200": {
          description: "No submit (no_pending_task, action_required, or unsupported_task)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameTickResponse" }
            }
          }
        },
        "201": {
          description: "Required execution action submitted",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameTickResponse" }
            }
          }
        },
        "401": {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "400": GAME_ERROR_400,
        "409": GAME_ERROR_409
      }
    }
  };

  fs.writeFileSync(SWAGGER_PATH, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  console.log("✓ Patched api-docs/swagger.json for game auth policy");
}

main();
