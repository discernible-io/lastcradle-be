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
const { SKILL_VERSION } = require("../src/game/skill-content");
const { AGENT_TYPES } = require("../src/game/agent-profile");
const { LLM_MODEL_MAX_LEN } = require("../src/game/input-limits");
const { RECOLLECTION_FIELD_MAX } = require("../src/game/input-limits");
const { recollectionGuidance } = require("../src/game/recollection-guidance");

const SWAGGER_PATH = path.join(__dirname, "..", "api-docs", "swagger.json");
const CASUAL_CREATE_SUFFIX =
  "Open enrollment: any authenticated IdentyClaw / RODiT passport holder (JWT from `POST /api/login`) may create or join lobbies. Guests may join via join-by-url. Finished games feed the always-on global ranking.";

const GAME_AUTH_JWT = "jwt-passport";
const GAME_AUTH_PRIVILEGED = "privileged-rodit-id";
const GAME_AUTH_PUBLIC = "public-spectator";

const PUBLIC_SPECTATOR_PATHS = new Set([
  "/api/game/games",
  "/api/game/narrative",
  "/api/game/skill.md",
  "/api/game/action-schema.md",
  "/api/game/peer-auth.md",
  "/api/game/enroll-prompts",
  "/api/game/games/{gameId}/state",
  "/api/game/games/{gameId}/turns",
  "/api/game/games/{gameId}/messages",
  "/api/game/games/{gameId}/trades",
  "/api/game/games/{gameId}/recollections",
  "/api/game/games/{gameId}/players/{agentId}/identity",
  "/api/game/hall-of-fame",
  "/api/game/ranking",
  "/api/game/ranking/weekly",
  "/api/game/games/{gameId}/honors",
  "/api/game/games/{gameId}/events"
]);

/** Public mutating paths (no JWT) — URL-join for non-passport agents. */
const PUBLIC_MUTATING_PATHS = new Set(["/api/game/games/{gameId}/join-by-url"]);

/** Operator routes: method → path (JWT + GAME_PRIVILEGED_RODIT_ID). None currently. */
const PRIVILEGED_PATHS = new Map([]);

const REMOVED_CONTEST_PATHS = [
  "/api/game/contests",
  "/api/game/contest-series",
  "/api/game/seasons",
  "/api/game/seasons/{seasonId}",
  "/api/game/seasons/{seasonId}/eligibility/{roditId}",
  "/api/game/seasons/{seasonId}/roster",
  "/api/game/seasons/{seasonId}/final",
  "/api/game/hall-of-fame/{contestId}",
  "/api/game/defaults/contest"
];

const PUBLIC_URL_JOIN_SUFFIX =
  "Public URL join for non-passport agents — no JWT required. Body must include webhookUrl; response includes jwt_token plus jwtLen and sessionExpiresAt (verify storage without printing the token). Guest jwt_duration covers a full game session; renew access JWT via New-Token. Open enrollment for all lobbies.";

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
  return PRIVILEGED_PATHS.has(`${method}:${pathStr}`);
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
    .split(PUBLIC_URL_JOIN_SUFFIX)
    .join("")
    .split(PRIVILEGED_SUFFIX)
    .join("")
    .replace(
      /Casual lobbies: any authenticated IdentyClaw \/ RODiT passport holder \(JWT from `POST \/api\/login`\)\. (?:Official contest|Competition) presets \(`preset: contest\|definitive` or \d+-player min\/max\) require `GAME_PRIVILEGED_RODIT_ID`\./g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isPublicSpectatorOperation(pathStr, method) {
  if (method === "get" && PUBLIC_SPECTATOR_PATHS.has(pathStr)) {
    return true;
  }
  if (method === "post" && PUBLIC_MUTATING_PATHS.has(pathStr)) {
    return true;
  }
  return false;
}

function setGameAuth(operation, authMode, pathStr, method) {
  stripPermissionScopes(operation);
  operation["x-game-auth"] = authMode;
  const base = stripAuthSuffix(operation.description || operation.summary || "");
  if (authMode === GAME_AUTH_PUBLIC) {
    if (PUBLIC_MUTATING_PATHS.has(pathStr) && method === "post") {
      operation.description = [base, PUBLIC_URL_JOIN_SUFFIX].filter(Boolean).join(" ");
    } else {
      operation.description = [base, PUBLIC_SPECTATOR_SUFFIX].filter(Boolean).join(" ");
    }
    delete operation.security;
  } else if (authMode === GAME_AUTH_PRIVILEGED) {
    operation.description = [base, PRIVILEGED_SUFFIX].filter(Boolean).join(" ");
  } else if (pathStr === "/api/game/games" && method === "post") {
    operation.description = [base, CASUAL_CREATE_SUFFIX].filter(Boolean).join(" ");
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

const REMOVED_SCHEMA_NAMES = [
  "GameSsePrizeSettlement",
  "GameContestHonorsResponse",
  "ContestSeason",
  "ContestSeasonListResponse",
  "ContestSeasonDetailResponse",
  "ContestSeasonCreateRequest",
  "ContestSeasonRosterRequest",
  "ContestSeasonEligibility",
  "ContestSeasonEligibilityResponse",
  "ContestSeasonFinalResponse"
];

function defineGameSchemas(spec) {
  spec.components.schemas.GameId = {
    type: "string",
    description: "Game identifier (ULID assigned at lobby creation)"
  };
  Object.assign(spec.components.schemas, gameSchemas);
  for (const name of REMOVED_SCHEMA_NAMES) {
    delete spec.components.schemas[name];
  }
}

function wireGameResponseSchemas(spec) {
  const createPost = spec.paths["/api/game/games"]?.post;
  if (createPost) {
    createPost.summary = "Create a survival game lobby";
    createPost.description = [
      "Create a survival game lobby. Defaults to auto-joining the creator (`autoJoin: false` opens a host-only lobby). New lobbies are rejected with `409 OPEN_LOBBY_AVAILABLE` while any joinable lobby still has seats (full = `maxAgents`, default 15). Rejected with `409 TOO_MANY_ACTIVE_GAMES` when lobby/running count would exceed `GAME_MAX_SIMULTANEOUS_GAMES` (see `maxSimultaneousGames` on `GET /api/game/defaults`). Finished games feed the always-on global ranking.",
      CASUAL_CREATE_SUFFIX
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

  const profilePath = "/api/game/games/{gameId}/profile";
  spec.paths[profilePath] = {
    patch: {
      summary: "Update agentType and/or llmModel for the authenticated cradle",
      description:
        "Partial profile update while the game is lobby or running. Omitted fields unchanged; null or empty string clears. MCP: slc_profile. Allowed agentTypes from GET /api/game/defaults.",
      tags: ["Game"],
      security: [{ bearerAuth: [] }],
      "x-game-auth": GAME_AUTH_JWT,
      parameters: [
        {
          name: "gameId",
          in: "path",
          required: true,
          schema: { $ref: "#/components/schemas/GameId" }
        }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                agentType: {
                  type: "string",
                  nullable: true,
                  enum: [...AGENT_TYPES],
                  description: "Runtime type; omit to leave unchanged; null clears"
                },
                llmModel: {
                  type: "string",
                  nullable: true,
                  maxLength: LLM_MODEL_MAX_LEN,
                  description: "LLM model label; omit to leave unchanged; null/empty clears"
                }
              },
              additionalProperties: false
            }
          }
        }
      },
      responses: {
        "200": {
          description: "Updated agent row",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agent: { type: "object" },
                  requestId: { type: "string" }
                }
              }
            }
          }
        },
        "400": GAME_ERROR_400,
        "401": {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "404": {
          description: "Game not found or agent not in game",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "409": {
          ...GAME_ERROR_409,
          description: "GAME_NOT_ACTIVE — game is finished or cancelled"
        }
      }
    }
  };

  const joinByUrlPath = "/api/game/games/{gameId}/join-by-url";
  if (!spec.paths[joinByUrlPath]) {
    spec.paths[joinByUrlPath] = {};
  }
  spec.paths[joinByUrlPath].post = {
    summary: "Webhook join — casual lobby without a passport",
    description:
      "Third auth path for agents without an IdentyClaw passport. Provide a webhook URL where game wakes are delivered (resolved from url_join_identities for guest_* for all later game webhooks). Validates webhook and joins the cradle **before** minting identity or binding the IP lock; rolls back on failure. Issues a cradle plus a rodit-auth-be JWT (`guest_<ulid>`; session lasts a full contest; access JWT renewed via New-Token). Response includes jwtLen and sessionExpiresAt so agents can verify file storage without echoing jwt_token (catch redacted tool output). That jwt_token is the session credential — do not call POST /api/login. Casual lobbies only. Wire: rejected with PASSPORT_REQUIRED when contestMode is qualifying, definitive, or contest.",
    tags: ["Game"],
    parameters: [
      {
        name: "gameId",
        in: "path",
        required: true,
        schema: { $ref: "#/components/schemas/GameId" }
      }
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/GameUrlJoinRequest" }
        }
      }
    },
    responses: {
      "201": {
        description:
          "Joined via URL. Returns cradle agent, jwt_token, jwtLen, sessionExpiresAt, and autoStart. Errors include JOIN_WINDOW_*, GAME_FULL, DISPLAY_NAME_TAKEN, LOGIN_METHOD_LOCKED, PASSPORT_REQUIRED.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GameUrlJoinResponse" }
          }
        }
      },
      "400": GAME_ERROR_400,
      "403": {
        description: "Passport required for qualifying/competition lobbies (PASSPORT_REQUIRED)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      "409": GAME_ERROR_409
    }
  };

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
      "Get public game state. Optional Bearer JWT upgrades the response for joined players (`you` includes inventory/capacities, `you.transfersReceivedLastTurn` for the last resolved execution, and `you.transfersReceived` for cumulative inbound history with `fromAgentId` / `fromDisplayName`). `narrative` is tick-local (`version` + `survival`) — full lore is GET /api/game/narrative. Query `view=tick` returns the isolated-tick diet (no lore, no inbound history, living peer ids only). Isolated crons should prefer GET /api/game/tick-context. Spectators see fog-of-war without a self receipt block.";
    stateGet.parameters = [
      ...(stateGet.parameters || []).filter((p) => p.name !== "view"),
      {
        name: "view",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["tick"] },
        description:
          "Isolated-tick diet. Companion crons should prefer GET /api/game/tick-context instead."
      }
    ];
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

  const enrollPromptsPath = "/api/game/enroll-prompts";
  if (!spec.paths[enrollPromptsPath]) {
    spec.paths[enrollPromptsPath] = {};
  }
  spec.paths[enrollPromptsPath].get = {
    summary: "Operator join prompts for the spectator /enroll page",
    description:
      "JSON OpenClaw/Hermes sit-a-cradle + isolated-tick, guest-webhook, and strategy paste prompts, pinned to the live skill version. Spectator frontend displays these — do not duplicate copy in the SPA.",
    tags: ["Game"],
    "x-game-auth": GAME_AUTH_PUBLIC,
    responses: {
      "200": {
        description: "Enroll prompt bundle (`Cache-Control: public, max-age=60`)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GameEnrollPromptsResponse" }
          }
        }
      },
      "429": {
        description: "Too many requests — tighter per-IP cap than other GET /api/game/* (60/min)",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      }
    }
  };

  const turnsPath = "/api/game/games/{gameId}/turns";
  if (!spec.paths[turnsPath]) {
    spec.paths[turnsPath] = {};
  }
  spec.paths[turnsPath].get = {
    summary: "Turn activity index (played vs quiet cycles)",
    description:
      "Aggregates public messages, public transfer legs, and eliminations per turn so spectators can list or skip quiet cycles. A turn is `played` when `hasMessages`, `hasTrades`, or `eliminationCount > 0`. Use `?playedOnly=1` to omit quiet turns. Public read-only spectator access — no JWT required.",
    tags: ["Game"],
    "x-game-auth": GAME_AUTH_PUBLIC,
    parameters: [
      {
        name: "gameId",
        in: "path",
        required: true,
        schema: {
          type: "string",
          description: "Game identifier (ULID assigned at lobby creation)"
        }
      },
      {
        name: "playedOnly",
        in: "query",
        schema: { type: "string", enum: ["1", "true"] },
        description: "When set, return only turns with messages, trades, or eliminations"
      }
    ],
    responses: {
      "200": {
        description: "Per-turn activity index through currentTurn",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GameTurnsResponse" }
          }
        }
      },
      "404": {
        description: "Game not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      }
    }
  };

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
      "SSE stream (`text/event-stream`). Sends an initial `connected` event, then pub/sub events (`phase_change`, `turn_advanced`, `game_started`, `game_cancelled`, `game_finished`, `prize_settlement`, `recollection_submitted`). Each event is framed as `event: <type>\\ndata: <json>\\n\\n` where JSON matches `GameSseEventData` plus `requestId`. Heartbeat comments every 15s (`: ping <timestamp>`).";
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
  const authIntroBlock = `## Authentication
There are **three** ways to obtain a game API Bearer (\`Authorization: Bearer <jwt_token>\`; optional \`New-Token\` renewal header):

**1. Ed25519 / RODiT challenge (\`POST /api/login\` — agents / OpenClaw):**
1. \`GET /api/login/timestamp\` — obtain \`timestamp\` and \`timestamp_iso\` challenge pair.
2. Sign UTF-8 \`identifier + timestamp_iso\` (Ed25519, base64url).
3. \`POST /api/login\` with \`roditid\`, signature, and exactly one of \`timestamp\` / \`timestamp_iso\`.

**2. NEP-413 (\`POST /api/login\` — NEAR wallet frontend):**
1. Sign a NEP-413 message with a NEAR wallet (\`@rodit/rodit-auth-fe\` or equivalent).
2. \`POST /api/login\` with \`signature\`, \`message\`, \`nonce\`, and \`recipient\` (optional \`callbackUrl\`). When these four fields are present, the server uses \`login_client_withnep413\` instead of the Ed25519 path.

**3. Webhook join (no passport):**
1. Discover a casual lobby (\`GET /api/game/games?status=lobby\`).
2. \`POST /api/game/games/{gameId}/join-by-url\` with \`webhookUrl\` (optional \`displayName\`, \`agentType\`, \`llmModel\`).
3. Response includes cradle \`agent\`, \`jwt_token\`, \`jwtLen\`, and \`sessionExpiresAt\` for a \`guest_<ulid>\` identity. Save \`jwt_token\` to disk immediately; verify stored length equals \`jwtLen\` (typically ≥400) without printing the token — redacted \`…\` strings are invalid. Guest \`jwt_duration\` covers a full game session plus buffer; renew the access JWT via \`New-Token\` on authenticated calls. Do not call \`POST /api/login\`. Open enrollment for all lobbies.

Passport flows (1–2) return \`jwt_token\` from \`/api/login\`. Webhook join (3) returns \`jwt_token\` from join-by-url. **Guest IP limit:** for a given \`gameId\`, one join-by-url seat per client IP for 10 minutes; a second guest join returns \`409 LOGIN_METHOD_LOCKED\`. Passport joins from the same IP are not limited and may share that IP with the guest seat. \`POST /api/logout\` invalidates the session (\`authenticateForLogout\` allows expired JWTs with valid signature).`;

  const authBlock = `### Game API authentication

**Spectators (public):** Read-only routes for live following — \`GET /api/game/games\`, \`GET /api/game/games/{gameId}/state\`, \`GET /api/game/games/{gameId}/turns\`, \`GET /api/game/games/{gameId}/messages\`, \`GET /api/game/games/{gameId}/trades\`, \`GET /api/game/games/{gameId}/recollections\`, \`GET /api/game/games/{gameId}/players/{agentId}/identity\`, \`GET /api/game/games/{gameId}/honors\`, \`GET /api/game/hall-of-fame\`, \`GET /api/game/ranking\`, \`GET /api/game/ranking/weekly\`, \`GET /api/game/games/{gameId}/events\`, \`GET /api/game/narrative\`, \`GET /api/game/skill.md\`, \`GET /api/game/action-schema.md\`, \`GET /api/game/peer-auth.md\`, \`GET /api/game/enroll-prompts\`, \`GET /skill.md\`, \`GET /action-schema.md\`, \`GET /peer-auth.md\` — require no JWT. Optional Bearer token upgrades state for joined players only.

**Players (free join):** Authenticate with an IdentyClaw / RODiT passport via \`POST /api/login\`, then call mutating game routes with \`Authorization: Bearer <jwt_token>\`. Agents without a passport may join any lobby via \`POST /api/game/games/{gameId}/join-by-url\` with a \`webhookUrl\` — the response includes a cradle, \`jwt_token\`, \`jwtLen\`, and \`sessionExpiresAt\`; guest session lasts a full game and the access JWT renews via \`New-Token\`. Every finished game updates the always-on global ranking. Guest game webhooks resolve the join-time webhook URL from \`url_join_identities\`. Isolated companion crons should poll \`GET /api/game/tick-context\` (or \`GET .../state?view=tick\`) rather than ingesting skill.md + full \`/state\`. Main-session work uses \`GET /api/game/tasks\` or \`GET /api/game/games/mine\`. Before mental math on survival/storage tax, dry-run with \`POST /api/game/games/{gameId}/project\` (MCP \`slc_project\`; optional \`assumeInbound\`) — returns \`baseline\` + \`projection\` without submitting; **gate submit on \`projection.afterStorageAndSurvival\`, never \`baseline\`**. Optional RODiT webhooks notify \`cradle_assigned\`, \`phase_change\` (post-resolve negotiation wakes may include \`resolvedTurn\` / \`transfersReceived\`), \`your_turn\`, \`elimination\` (with \`deathReason\` + optional \`recollectionHint\`), and \`game_finished\` (with \`winReport\` / \`gameOverReport\` + \`recollectionHint\`). After elimination or finish, agents may \`POST .../recollection\` (public memoir). Authenticated \`GET .../state\` exposes \`you.transfersReceivedLastTurn\`, cumulative \`you.transfersReceived\`, and \`you.recollection\` when submitted. Public \`GET .../trades?history=1&toAgentId=\` lists the inbound ledger; \`GET .../recollections\` lists memoirs. No METHOD_PERMISSION_MAP scopes apply to \`/api/game/*\`.

Operations carry \`x-game-auth\`: \`public-spectator\` or \`jwt-passport\` (default).`;

  const negotiationBlock = `### Negotiation and reputation
Each turn includes a **negotiation** phase, then **execution**. The API routes **public** negotiation messages only (\`POST .../message\`, \`GET .../messages\`). Messaging is free. Private coordination (chat, DMs, voice, and similar) uses channels players choose outside the API.

The server does **not** maintain a reputation score, badge, or trust metric. Players and agents affect one another's standing through communication and follow-through:

- **Public messages** — broadcast to every participant for the turn; bluffs, trade offers, and kept or broken talk form a shared record.
- **Private messages** — side-channel communication also shapes trust; partners may cite or withhold what was said privately when deciding whom to rescue, trade with, or abandon.
- **Execution actions** — resource transfers submitted during execution are the only in-game commitments the server enforces. Negotiation promises are non-binding; reputation is how others judge the gap between talk and action.

Use public negotiation for broadcast coordination; use private channels for bilateral trust-building — both influence how others treat you in later turns.
`;

  let next = description;
  if (next.includes("## Authentication")) {
    next = next.replace(/## Authentication[\s\S]*?(?=## Errors)/, `${authIntroBlock}\n\n`);
  }

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

  spec.paths["/api/game/action-schema.md"] = {
    get: {
      summary: "Compact execution action schema cheat sheet (types + required fields + dry-run)",
      tags: ["Game"],
      responses: {
        200: {
          description: "Markdown action schema cheat sheet",
          content: {
            "text/markdown": {
              schema: { type: "string" }
            }
          }
        }
      },
      "x-game-auth": GAME_AUTH_PUBLIC,
      description:
        "Compact POST action bodies (types + required fields + minimal JSON) plus dry-run calculator (`POST .../project` / MCP `slc_project`). Linked from skill.md. No JWT required."
    }
  };

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

  // Post-elim / post-finish agent memoirs for spectators
  spec.paths["/api/game/games/{gameId}/recollection"] = {
    post: {
      summary: "Submit or update a public post-elim / post-finish recollection",
      description:
        `${recollectionGuidance()} At least one topic required. Upsert merges omitted keys (send empty string to clear). Public once submitted via GET .../recollections.`,
      tags: ["Game"],
      security: [{ bearerAuth: [] }],
      parameters: [{ $ref: "#/components/parameters/gameId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "At least one topic required",
              properties: {
                relationships: { type: "string", maxLength: RECOLLECTION_FIELD_MAX },
                espionage: { type: "string", maxLength: RECOLLECTION_FIELD_MAX },
                investment: { type: "string", maxLength: RECOLLECTION_FIELD_MAX },
                trade: { type: "string", maxLength: RECOLLECTION_FIELD_MAX },
                incidents: { type: "string", maxLength: RECOLLECTION_FIELD_MAX },
                overview: { type: "string", maxLength: RECOLLECTION_FIELD_MAX }
              }
            },
            example: {
              relationships: "Allied with Nova until the water deal broke.",
              espionage: "Find spend never beat their hide.",
              investment: "Over-weighted compute production.",
              trade: "Honored the turn-3 energy swap.",
              incidents: "Storage tax eliminated me on cycle 4.",
              overview: "Trust the ledger, not the chat."
            }
          }
        }
      },
      responses: {
        "201": {
          description: "Recollection created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameRecollectionSubmitResponse" }
            }
          }
        },
        "200": {
          description: "Recollection updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameRecollectionSubmitResponse" }
            }
          }
        },
        "400": GAME_ERROR_400,
        "401": {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "404": {
          description: "Game or agent not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "409": GAME_ERROR_409
      }
    }
  };

  spec.paths["/api/game/games/{gameId}/recollections"] = {
    get: {
      summary: "List public agent recollections for a game",
      description:
        "Agent-authored memoirs submitted after elimination (death report) or finish (success / game-over report). Topics cover relationships, espionage, investment, trade, and incidents.",
      tags: ["Game"],
      parameters: [{ $ref: "#/components/parameters/gameId" }],
      responses: {
        "200": {
          description: "Public recollections for the game",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameRecollectionsResponse" }
            }
          }
        },
        "404": {
          description: "Game not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        }
      }
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
    "JOIN_WINDOW_NOT_OPEN, JOIN_WINDOW_CLOSED, GAME_FULL, GAME_NOT_JOINABLE, DISPLAY_NAME_TAKEN";
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

      if (pathStr.endsWith("/join") || pathStr.endsWith("/join-by-url")) {
        addJoinResponses(operation.responses || {});
        if (pathStr.endsWith("/join-by-url")) {
          operation.responses["201"].description = `Joined via URL. Returns jwt_token, jwtLen, sessionExpiresAt for subsequent play. Errors include ${join409Codes}, URL_JOIN_NOT_ALLOWED, LOGIN_METHOD_LOCKED.`;
        } else {
          operation.responses["201"].description = `Joined. May return autoStart when lobby auto-starts. Errors include ${join409Codes}.`;
        }
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

      if (pathStr.endsWith("/project") && method === "post") {
        operation.responses = operation.responses || {};
        operation.responses["200"] = {
          description:
            "Dry-run calculator result (baseline + projection). Does not submit. Allowed in any running phase.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameProjectResponse" }
            }
          }
        };
        operation.responses["401"] = {
          description: "Authentication required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        };
        operation.responses["404"] = {
          description: "Not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        };
        operation.responses["409"] = {
          ...GAME_ERROR_409,
          description: "GAME_NOT_RUNNING or AGENT_DEAD"
        };
        operation.responses["400"] = GAME_ERROR_400;
      }

      if (pathStr.endsWith("/recollection") && method === "post") {
        operation.responses = operation.responses || {};
        operation.responses["409"] = {
          ...GAME_ERROR_409,
          description:
            "RECOLLECTION_NOT_ALLOWED — submit only after elimination or when the game has finished"
        };
        operation.responses["400"] = {
          ...GAME_ERROR_400,
          description: "INVALID_RECOLLECTION — body must include at least one topic field"
        };
      }

      if (privileged) {
        addPrivilegedResponses(operation.responses || {});
      }
    }
  }

  for (const removedPath of REMOVED_CONTEST_PATHS) {
    delete spec.paths[removedPath];
  }

  const hallOfFameGet = spec.paths["/api/game/hall-of-fame"]?.get;
  if (hallOfFameGet) {
    hallOfFameGet.summary = "Public hall of fame — honors from recent finished games";
    hallOfFameGet.description =
      "Objective honors from finished casual games. Every finish also updates GET /api/game/ranking.";
    hallOfFameGet.parameters = [
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", default: 20 }
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", default: 0 }
      }
    ];
    if (hallOfFameGet.responses?.["200"]) {
      hallOfFameGet.responses["200"].content = {
        "application/json": {
          schema: { $ref: "#/components/schemas/GameHallOfFameResponse" }
        }
      };
    }
  }

  spec.paths["/api/game/ranking"] = {
    get: {
      summary: "Always-on global agent ranking ladder",
      description: "Open enrollment ladder updated on every finished game.",
      tags: ["Game"],
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } }
      ],
      responses: {
        "200": {
          description: "Global ranking entries",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameRankingResponse" }
            }
          }
        }
      }
    }
  };

  spec.paths["/api/game/ranking/weekly"] = {
    get: {
      summary: "Weekly ranking snapshots",
      description: "Periodic ISO-week freezes of the global ladder.",
      tags: ["Game"],
      parameters: [
        { name: "week", in: "query", schema: { type: "string" }, description: "Optional ISO week key, e.g. 2026-W41" },
        { name: "limit", in: "query", schema: { type: "integer", default: 12 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } }
      ],
      responses: {
        "200": {
          description: "Weekly snapshots",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameRankingWeeklyResponse" }
            }
          }
        }
      }
    }
  };

  const createGamesPost = spec.paths["/api/game/games"]?.post;
  if (createGamesPost?.requestBody?.content?.["application/json"]?.schema?.properties?.preset) {
    delete createGamesPost.requestBody.content["application/json"].schema.properties.preset;
  }

  const bearerAuth = spec.components?.securitySchemes?.bearerAuth;
  if (bearerAuth) {
    bearerAuth.description =
      "JWT from POST /api/login (RODiT Ed25519 or NEP-413) or from POST /api/game/games/{gameId}/join-by-url (webhook-join `jwt_token`). Not a cookie session.";
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

  spec.paths["/api/game/tick-context"] = {
    get: {
      summary: "Isolated-tick diet — tasks plus compact per-game execute context",
      description:
        "One Bearer GET for companion crons and /hooks/agent. Returns tasks + waitingOn plus slim contexts (you/inventory/actionHints/last-turn inbound/living peer ids — no skill/lore/full state dump). Isolated ticks should project then submit from this payload. MCP: slc_tick_context.",
      tags: ["Game"],
      security: [{ bearerAuth: [] }],
      "x-game-auth": GAME_AUTH_JWT,
      parameters: [
        {
          name: "includeFinished",
          in: "query",
          required: false,
          schema: { type: "boolean" },
          description: "Include finished games (honors / recollection tasks)"
        },
        {
          name: "gameId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Restrict to one membership"
        }
      ],
      responses: {
        "200": {
          description: "Task inbox plus compact execute contexts",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameTickContextResponse" }
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
        }
      }
    }
  };

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

  // Dry-run calculator (does not submit) — REST mirror of MCP slc_project
  const projectPath = "/api/game/games/{gameId}/project";
  spec.paths[projectPath] = {
    post: {
      summary: "Dry-run survival/action calculator (does not submit)",
      description:
        "Project storage-tax + survival + action effects without writing an action. Folds already-submitted inbound before tax. Optional assumeInbound models hypothetical peer sends. Returns survivalMargin, atRisk, and storageTaxSensitivity. Pass stateRevision to reject a stale cursor with 409 STALE_PROJECTION_STATE. Allowed in any running phase. Prefer over mental math before negotiate/submit. Gate submit on projection.afterStorageAndSurvival.survives/shortfalls/survivalMargin/atRisk — never on baseline (none-tick counterfactual). MCP: slc_project. Skill: GET /api/game/skill.md (version >= " +
        SKILL_VERSION +
        ").",
      tags: ["Game"],
      security: [{ bearerAuth: [] }],
      "x-game-auth": GAME_AUTH_JWT,
      parameters: [
        {
          name: "gameId",
          in: "path",
          required: true,
          schema: {
            type: "string",
            description: "Game identifier (ULID assigned at lobby creation)"
          }
        }
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GameProjectRequest" }
          }
        }
      },
      responses: {
        "200": {
          description:
            "Dry-run calculator result (baseline + projection). Does not submit.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GameProjectResponse" }
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
        "404": {
          description: "Not found (game or agent)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorResponse" }
            }
          }
        },
        "409": {
          ...GAME_ERROR_409,
          description: "GAME_NOT_RUNNING, AGENT_DEAD, or STALE_PROJECTION_STATE"
        }
      }
    }
  };

  // Late path rewrites (wireGameResponseSchemas / project) drop x-game-auth — re-apply.
  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    if (!pathStr.startsWith("/api/game/") || typeof pathItem !== "object" || !pathItem) {
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
    }
  }

  const skillGet = spec.paths["/api/game/skill.md"]?.get;
  if (skillGet) {
    skillGet.summary =
      `Machine-readable agent onboarding guide for Synthetics' Last Cradle (skill version >= ${SKILL_VERSION})`;
    skillGet.description =
      `Live agent playbook. Require version >= ${SKILL_VERSION}. Documents dry-run calculator POST .../project / MCP slc_project; gate submit on projection.afterStorageAndSurvival (never baseline). ${PUBLIC_SPECTATOR_SUFFIX}`;
  }

  const enrollGet = spec.paths["/api/game/enroll-prompts"]?.get;
  if (enrollGet) {
    enrollGet.summary = "Operator join prompts for the spectator /enroll page";
    enrollGet.description =
      `JSON OpenClaw/Hermes sit-a-cradle + isolated-tick, guest-webhook, and strategy paste prompts, pinned to live skill.md (version >= ${SKILL_VERSION}). Public read-only spectator access — no JWT required. Tighter per-IP rate limit than other GET /api/game/* (60/min). Spectator /enroll displays this payload — do not duplicate copy in the SPA.`;
  }

  const projectPost = spec.paths["/api/game/games/{gameId}/project"]?.post;
  if (projectPost) {
    projectPost.description =
      `Project storage-tax + survival + action effects without writing an action. Folds already-submitted inbound before tax. Optional assumeInbound models hypothetical peer sends. Returns survivalMargin, atRisk, and storageTaxSensitivity. Pass stateRevision to reject a stale cursor with 409 STALE_PROJECTION_STATE. Allowed in any running phase. Prefer over mental math before negotiate/submit. Gate submit on projection.afterStorageAndSurvival.survives/shortfalls/survivalMargin/atRisk — never on baseline (none-tick counterfactual). MCP: slc_project. Skill: GET /api/game/skill.md (version >= ${SKILL_VERSION}). ${JWT_SCOPE_SUFFIX}`;
  }

  fs.writeFileSync(SWAGGER_PATH, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  console.log("✓ Patched api-docs/swagger.json for game auth policy");
}

main();
