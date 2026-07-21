/**
 * SLC game MCP tool implementations (shared by streamable /mcp).
 */

const engine = require("../game/engine");
const repo = require("../game/repository");
const {
  listActiveGamesForRodit,
  listTasksInboxForRodit
} = require("../game/agent-tasks");
const { buildGameSkillMarkdown, SKILL_VERSION } = require("../game/skill-content");
const { onGamePhaseUpdated } = require("../game/webhooks");
const scheduler = require("../game/scheduler");
const { logger } = require("@rodit/rodit-auth-be");

const GAME_TOOL_DEFS = [
  {
    name: "slc_skill",
    description: "Fetch live GET /api/game/skill.md playbook (require version >= 1.4.0).",
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
    name: "slc_message_report",
    description: "POST message-report sent/received counts.",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        sent: { type: "number" },
        received: { type: "number" }
      },
      required: ["gameId", "sent", "received"],
      additionalProperties: false
    }
  },
  {
    name: "slc_action",
    description: "POST execution action (type none|transfer|invest).",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        type: { type: "string" },
        payload: { type: "object" }
      },
      required: ["gameId", "type"],
      additionalProperties: false
    }
  },
  {
    name: "slc_tick",
    description:
      "Submit one required task if any (message-report defaults 0/0, action defaults none). Returns waitingOn when idle.",
    inputSchema: {
      type: "object",
      properties: {
        sent: { type: "number" },
        received: { type: "number" },
        actionType: { type: "string" }
      },
      additionalProperties: false
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
    case "slc_join": {
      const roditId = requireRodit(req);
      const gameId = args.gameId;
      const displayName = args.displayName;
      const agent = await engine.joinGame(gameId, { roditId, displayName });
      return { agent };
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
    case "slc_message_report": {
      const roditId = requireRodit(req);
      const agent = await repo.getAgentByRoditId(args.gameId, roditId);
      if (!agent) {
        const err = new Error("You must join the game before submitting reports");
        err.statusCode = 404;
        err.code = "AGENT_NOT_IN_GAME";
        throw err;
      }
      const result = await engine.submitMessageReport(args.gameId, agent.id, {
        sent: args.sent,
        received: args.received
      });
      if (result.messageReportPhaseCompleted) {
        const game = await repo.getGameById(args.gameId);
        if (game?.status === "running" && game.phase === "execution") {
          scheduler.registerGame(game);
          onGamePhaseUpdated(game.id).catch(() => {});
        }
      }
      return result;
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
      const body = { type: args.type, action: args.type, ...(args.payload || {}) };
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
      const inbox = await listTasksInboxForRodit(roditId);
      const required = (inbox.tasks || []).find((t) => t.required) || (inbox.tasks || [])[0];
      if (!required) {
        return {
          submitted: false,
          reason: "no_pending_task",
          tasks: inbox.tasks,
          waitingOn: inbox.waitingOn,
          note: "Empty tasks does not mean unblocked — check waitingOn."
        };
      }
      if (required.taskType === "submit_message_report") {
        return callGameTool(
          "slc_message_report",
          {
            gameId: required.gameId,
            sent: args.sent ?? 0,
            received: args.received ?? 0
          },
          req
        ).then(async (result) => ({
          submitted: true,
          taskType: required.taskType,
          gameId: required.gameId,
          result,
          waitingOn: (await listTasksInboxForRodit(roditId)).waitingOn
        }));
      }
      if (required.taskType === "submit_execution_action") {
        return callGameTool(
          "slc_action",
          {
            gameId: required.gameId,
            type: args.actionType || "none"
          },
          req
        ).then(async (result) => ({
          submitted: true,
          taskType: required.taskType,
          gameId: required.gameId,
          result,
          waitingOn: (await listTasksInboxForRodit(roditId)).waitingOn
        }));
      }
      return {
        submitted: false,
        reason: "unsupported_task",
        task: required,
        waitingOn: inbox.waitingOn
      };
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
