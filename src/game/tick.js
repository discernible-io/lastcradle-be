/**
 * One-shot required-task submit (execution action).
 * Shared by MCP `slc_tick` and REST `POST /api/game/tick`.
 */

const engine = require("./engine");
const repo = require("./repository");
const scheduler = require("./scheduler");
const { onGamePhaseUpdated } = require("./webhooks");
const { listTasksInboxForRodit, TASK_TYPES } = require("./agent-tasks");

function applyActionSideEffects(result) {
  if (result?.turnCompleted && result.game) {
    scheduler.onTurnCompleted(result.game);
  } else if (result?.game?.status === "running" && result.game.phase === "execution") {
    onGamePhaseUpdated(result.game.id).catch(() => {});
  }
}

/**
 * @param {string} roditId
 * @param {{ actionType?: string }} [opts]
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
