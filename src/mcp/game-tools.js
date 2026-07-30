/**
 * SLC game MCP tool implementations (shared by streamable /mcp).
 */

const engine = require("../game/engine");
const repo = require("../game/repository");
const orchestrator = require("../game/contest-orchestrator");
const {
  listActiveGamesForRodit,
  listTasksInboxForRodit
} = require("../game/agent-tasks");
const { buildGameSkillMarkdown, SKILL_VERSION } = require("../game/skill-content");
const { notifyCradleAssigned, onGamePhaseUpdated } = require("../game/webhooks");
const { resolvePresetConfig } = require("../game/defaults");
const {
  isPrivilegedRoditId,
  isOfficialContestConfig
} = require("../game/permissions");
const scheduler = require("../game/scheduler");
const { logger } = require("@rodit/rodit-auth-be");

const GAME_TOOL_DEFS = [
  {
    name: "slc_skill",
    description: "Fetch live GET /api/game/skill.md playbook (require version >= 1.8.9).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "slc_games_mine",
    description: "List active games for the authenticated agent (GET /api/game/games/mine).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "slc_lobbies",
    description: "List open lobbies (GET /api/game/games?status=lobby).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "slc_create",
    description:
      "Create a casual lobby (POST /api/game/games). Defaults to auto-joining the creator. Rejects with OPEN_LOBBY_AVAILABLE while joinable casual lobbies still have seats. Official contest presets require privileged RODiT.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["contest", "definitive", "practice"] },
        config: { type: "object", additionalProperties: true },
        joiningWindowStartsAt: { type: "string" },
        displayName: { type: "string" },
        autoJoin: {
          type: "boolean",
          description: "Join the creator into the new lobby (default true)."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "slc_join",
    description: "Join a lobby (POST /api/game/games/{gameId}/join).",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        displayName: { type: "string" }
      },
      required: ["gameId"],
      additionalProperties: false
    }
  },
  {
    name: "slc_tasks",
    description: "Task inbox with waitingOn peers (GET /api/game/tasks).",
    inputSchema: {
      type: "object",
      properties: { includeFinished: { type: "boolean" } },
      additionalProperties: false
    }
  },
  {
    name: "slc_state",
    description: "GET /api/game/games/{gameId}/state",
    inputSchema: {
      type: "object",
      properties: { gameId: { type: "string" } },
      required: ["gameId"],
      additionalProperties: false
    }
  },
  {
    name: "slc_message",
    description: "POST public negotiation message.",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        body: { type: "string" }
      },
      required: ["gameId", "body"],
      additionalProperties: false
    }
  },
  {
    name: "slc_action",
    description:
      "POST execution action only (type none|transfer|invest|transfer_and_invest). There is no GET .../action. Before invest, read you.actionHints.storageWaterCostIfNoSpend / waterAfterStorageIfNoSpend and cap amount at maxInvestAmountAfterSurvival. Response includes outbound-only projection (inventory/capacities/waste). Optional hide/find for intelligence.",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        type: { type: "string" },
        payload: {
          type: "object",
          description: "Action fields including optional hide and find",
          additionalProperties: true
        },
        hide: {
          oneOf: [{ type: "number" }, { type: "object", additionalProperties: true }],
          description: "Compute spend to raise hide this turn"
        },
        find: {
          type: "array",
          description: "Scout living peer ULIDs",
          items: {
            type: "object",
            properties: {
              targetAgentId: { type: "string" },
              compute: { type: "number" }
            },
            additionalProperties: true
          }
        }
      },
      required: ["gameId", "type"],
      additionalProperties: false
    }
  },
  {
    name: "slc_tick",
    description:
      "Submit one required execution action if any (POST). Pass an explicit action (type none|transfer|invest|transfer_and_invest, plus fields; optional hide/find). Read actionHints.storageWaterCostIfNoSpend / waterAfterStorageIfNoSpend before investing; cap at maxInvestAmountAfterSurvival. Successful submit returns outbound-only projection (inventory/capacities/waste). Empty body returns action_required — does not default to none. AFK timeout still submits none via the scheduler.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["none", "transfer", "invest", "transfer_and_invest"],
          description: "Execution action type chosen from current state"
        },
        actionType: {
          type: "string",
          enum: ["none", "transfer", "invest", "transfer_and_invest"],
          description: "Alias for type"
        },
        action: {
          type: "object",
          description: "Full nested action payload (preferred when transferring/investing)",
          additionalProperties: true
        },
        toAgentId: { type: "string" },
        energy: { type: "number" },
        water: { type: "number" },
        compute: { type: "number" },
        target: { type: "string", enum: ["energy", "water", "compute"] },
        amount: { type: "number" },
        transfers: {
          type: "array",
          description: "Multi-recipient transfer legs (capped by maxTransferRecipients)",
          items: { type: "object", additionalProperties: true }
        },
        transfer: { type: "object", additionalProperties: true },
        invest: { type: "object", additionalProperties: true },
        hide: {
          oneOf: [{ type: "number" }, { type: "object", additionalProperties: true }],
          description: "Compute spend to raise hide this turn (number or { compute })"
        },
        find: {
          type: "array",
          description: "Scout living peer ULIDs when actionHints.hiddenRivalCount > 0",
          items: {
            type: "object",
            properties: {
              targetAgentId: { type: "string", description: "Living game agent ULID" },
              compute: { type: "number", description: "Compute spent to find this target" }
            },
            additionalProperties: true
          }
        }
      },
      additionalProperties: true
    }
  }
];

const PUBLIC_TOOL_DEFS = [
  {
    name: "list_resources",
    description: "Lists available MCP documentation resources",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_resource",
    description: "Retrieves an MCP documentation resource by URI",
    inputSchema: {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
      additionalProperties: false
    }
  }
];

function requireRodit(req) {
  const { roditIdFromUser } = require("../game/rodit-id");
  const roditId = roditIdFromUser(req?.user);
  if (!roditId) {
    const err = new Error("Authenticated agent identity required (Authorization: Bearer SLC JWT)");
    err.code = "AUTH_REQUIRED";
    err.statusCode = 401;
    throw err;
  }
  return roditId;
}

async function callGameTool(name, args, req) {
  switch (name) {
    case "slc_skill": {
      const markdown = buildGameSkillMarkdown(req);
      return { markdown, version: SKILL_VERSION, bytes: markdown.length };
    }
    case "slc_games_mine": {
      const roditId = requireRodit(req);
      const activeGames = await listActiveGamesForRodit(roditId);
      return { activeGames };
    }
    case "slc_lobbies": {
      requireRodit(req);
      const games = await repo.listGames({ status: "lobby" });
      return {
        games: await Promise.all(
          games.map(async (g) => ({
            id: g.id,
            status: g.status,
            agentCount: await repo.countAgents(g.id),
            joiningWindow: engine.joiningWindowDetails(g)
          }))
        )
      };
    }
    case "slc_create": {
      requireRodit(req);
      const configOverrides = resolvePresetConfig(args);
      if (isOfficialContestConfig(configOverrides) && !isPrivilegedRoditId(req)) {
        const err = new Error("Privileged RODiT identity required for this operation");
        err.code = "FORBIDDEN";
        err.statusCode = 403;
        throw err;
      }

      const game = await engine.createGame({
        config: configOverrides,
        joiningWindowStartsAt: args.joiningWindowStartsAt ?? null
      });
      orchestrator.registerLobbyGame(game);

      const gamePayload = {
        id: game.id,
        status: game.status,
        config: game.config,
        joiningWindow: engine.joiningWindowDetails(game)
      };

      if (args.autoJoin === false) {
        return { game: gamePayload, agent: null, autoStart: null };
      }

      const joinResult = await callGameTool(
        "slc_join",
        { gameId: game.id, displayName: args.displayName },
        req
      );
      return { game: gamePayload, agent: joinResult.agent, autoStart: joinResult.autoStart };
    }
    case "slc_join": {
      const roditId = requireRodit(req);
      const gameId = args.gameId;
      const existing = await repo.getAgentByRoditId(gameId, roditId);
      const agent = await engine.joinGame(gameId, {
        roditId,
        displayName: args.displayName
      });

      if (!existing) {
        const game = await repo.getGameById(gameId);
        await notifyCradleAssigned(req, { gameId, game, agent, roditId });
      }

      const autoStart = await orchestrator.evaluateLobbyAutoStart(gameId);
      return { agent, autoStart };
    }
    case "slc_tasks": {
      const roditId = requireRodit(req);
      return listTasksInboxForRodit(roditId, {
        includeFinished: Boolean(args.includeFinished)
      });
    }
    case "slc_state": {
      requireRodit(req);
      const roditId = requireRodit(req);
      const agent = await repo.getAgentByRoditId(args.gameId, roditId);
      return engine.getPublicState(args.gameId, { viewerAgentId: agent?.id ?? null });
    }
    case "slc_message": {
      const roditId = requireRodit(req);
      const agent = await repo.getAgentByRoditId(args.gameId, roditId);
      if (!agent) {
        const err = new Error("You must join the game before messaging");
        err.statusCode = 404;
        err.code = "AGENT_NOT_IN_GAME";
        throw err;
      }
      return engine.publishPublicMessage(args.gameId, agent.id, { body: args.body });
    }
    case "slc_action": {
      const roditId = requireRodit(req);
      const agent = await repo.getAgentByRoditId(args.gameId, roditId);
      if (!agent) {
        const err = new Error("You must join the game before submitting actions");
        err.statusCode = 404;
        err.code = "AGENT_NOT_IN_GAME";
        throw err;
      }
      const body = {
        type: args.type,
        action: args.type,
        ...(args.payload || {}),
        ...(args.hide != null ? { hide: args.hide } : {}),
        ...(args.find != null ? { find: args.find } : {})
      };
      const result = await engine.submitAction(args.gameId, agent.id, body);
      if (result.turnCompleted && result.game) {
        scheduler.onTurnCompleted(result.game);
      } else if (result.game?.status === "running" && result.game.phase === "execution") {
        onGamePhaseUpdated(result.game.id).catch((err) => {
          logger.warnWithContext("Phase webhook delivery failed", {
            component: "McpGameTools",
            gameId: result.game.id,
            error: err.message
          });
        });
      }
      return result;
    }
    case "slc_tick": {
      const roditId = requireRodit(req);
      const { runAgentTick } = require("../game/tick");
      return runAgentTick(roditId, args || {});
    }
    default: {
      const err = new Error(`Unknown tool: ${name}`);
      err.statusCode = 404;
      err.code = "MCP_TOOL_NOT_FOUND";
      throw err;
    }
  }
}

module.exports = {
  GAME_TOOL_DEFS,
  PUBLIC_TOOL_DEFS,
  callGameTool,
  requireRodit
};
