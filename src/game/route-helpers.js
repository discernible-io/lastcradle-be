/**
 * Shared helpers for game HTTP routes.
 */

const { errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const engine = require("./engine");
const repo = require("./repository");
const { roditIdFromUser } = require("./rodit-id");

function resolveRoditId(req) {
  return roditIdFromUser(req?.user);
}

function handleGameError(res, err, requestId) {
  return sendError(res, {
    statusCode: err.statusCode || 500,
    requestId,
    code: err.code || "GAME_ERROR",
    message: err.message,
    details: err.details || undefined
  });
}

function summarizeGame(game, agentCount = null) {
  return {
    id: game.id,
    status: game.status,
    agentCount,
    joiningWindow: engine.joiningWindowDetails(game),
    currentTurn: game.current_turn,
    phase: game.phase,
    startedAt: game.started_at,
    finishedAt: game.finished_at,
    winnerIds: game.winnerIds || [],
    createdAt: game.created_at
  };
}

async function resolveViewerAgentId(req, gameId) {
  const roditId = resolveRoditId(req);
  if (!roditId) {
    return null;
  }
  const viewer = await repo.getAgentByRoditId(gameId, roditId);
  return viewer?.id ?? null;
}

module.exports = {
  resolveRoditId,
  handleGameError,
  summarizeGame,
  resolveViewerAgentId
};
