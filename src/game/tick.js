/**
 * One-shot required-task submit (message-report / execution action).
 * Shared by MCP `slc_tick` and REST `POST /api/game/tick`.
 */

const engine = require("./engine");
const repo = require("./repository");
const scheduler = require("./scheduler");
const { onGamePhaseUpdated } = require("./webhooks");
const { listTasksInboxForRodit, TASK_TYPES } = require("./agent-tasks");

function applyMessageReportSideEffects(gameId, result) {
  if (!result?.messageReportPhaseCompleted) return;
  repo
    .getGameById(gameId)
    .then((game) => {
      if (game?.status === "running" && game.phase === "execution") {
        scheduler.registerGame(game);
        onGamePhaseUpdated(game.id).catch(() => {});
      }
    })
    .catch(() => {});
}

function applyActionSideEffects(result) {
  if (result?.turnCompleted && result.game) {
    scheduler.onTurnCompleted(result.game);
  } else if (result?.game?.status === "running" && result.game.phase === "execution") {
    onGamePhaseUpdated(result.game.id).catch(() => {});
  }
}

/**
 * @param {string} roditId
 * @param {{ sent?: number, received?: number, actionType?: string }} [opts]
 * @returns {Promise<object>}
 */
async function runAgentTick(roditId, opts = {}) {
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

  if (required.taskType === TASK_TYPES.SUBMIT_MESSAGE_REPORT) {
    const agent = await repo.getAgentByRoditId(required.gameId, roditId);
    if (!agent) {
      const err = new Error("You must join the game before submitting a message report");
      err.code = "AGENT_NOT_IN_GAME";
      err.statusCode = 404;
      throw err;
    }
    const sent = opts.sent ?? 0;
    const received = opts.received ?? 0;
    const result = await engine.submitMessageReport(required.gameId, agent.id, { sent, received });
    applyMessageReportSideEffects(required.gameId, result);
    const after = await listTasksInboxForRodit(roditId);
    return {
      submitted: true,
      taskType: required.taskType,
      gameId: required.gameId,
      payload: { sent, received },
      result,
      waitingOn: after.waitingOn
    };
  }

  if (required.taskType === TASK_TYPES.SUBMIT_EXECUTION_ACTION) {
    const agent = await repo.getAgentByRoditId(required.gameId, roditId);
    if (!agent) {
      const err = new Error("You must join the game before submitting actions");
      err.code = "AGENT_NOT_IN_GAME";
      err.statusCode = 404;
      throw err;
    }
    const type = opts.actionType || "none";
    const body = { type, action: type };
    const result = await engine.submitAction(required.gameId, agent.id, body);
    applyActionSideEffects(result);
    const after = await listTasksInboxForRodit(roditId);
    return {
      submitted: true,
      taskType: required.taskType,
      gameId: required.gameId,
      payload: body,
      result,
      waitingOn: after.waitingOn
    };
  }

  return {
    submitted: false,
    reason: "unsupported_task",
    task: required,
    waitingOn: inbox.waitingOn
  };
}

module.exports = {
  runAgentTick
};
